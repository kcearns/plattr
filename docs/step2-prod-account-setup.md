# Step 2: Production Account Setup

This guide walks through setting up Plattr's production environment in a dedicated AWS account with managed services.

## Prerequisites

- A separate AWS account for production
- AWS CLI profiles configured for both accounts
- CDK bootstrapped in the prod account
- Non-prod environment already running (see [Developer Guide](developer-guide.md))

## Architecture

Production runs on its own EKS cluster with AWS managed services instead of containerized equivalents:

| Service | Non-Prod | Production |
|---------|----------|------------|
| Database | Shared Aurora (schema-per-app) | Dedicated Aurora Serverless v2 |
| Redis | Redis pod in plattr-system | ElastiCache Serverless (Redis 7) |
| Search | OpenSearch pod in plattr-system | OpenSearch Service (managed) |
| Storage | S3 | S3 |
| Auth | Keycloak on EKS | Keycloak on EKS |

The operator auto-detects its mode via environment variables: if `REDIS_ENDPOINT` and `OPENSEARCH_ENDPOINT` are set, it runs in **managed mode** and creates ConfigMaps pointing to the AWS services. Otherwise, it runs in **container mode** and points to in-cluster pods.

## Step 1: Bootstrap the Prod Account

```bash
# Switch to prod account credentials
export AWS_PROFILE=plattr-prod

# Bootstrap CDK
npx cdk bootstrap aws://PROD_ACCOUNT_ID/ca-central-1
```

## Step 2: Deploy Production Infrastructure

From `packages/cdk`:

```bash
cd packages/cdk

# Deploy infra + operator
npx cdk deploy PlattrProdInfraStack PlattrProdOperatorStack \
  -c target=prod \
  -c account=PROD_ACCOUNT_ID \
  -c region=ca-central-1 \
  -c baseDomain=prod.yourcompany.dev \
  -c hostedZoneId=Z_PROD_HOSTED_ZONE_ID \
  -c nonprodAccountId=NONPROD_ACCOUNT_ID
```

This creates:
- **VPC** with public/private subnets (2 AZs, 1 NAT)
- **EKS cluster** `plattr-prod` (Auto Mode, compute fully managed by EKS)
- **Aurora Serverless v2** (PostgreSQL 16.4, 1-8 ACU)
- **ElastiCache Serverless** (Redis 7, `plattr-prod-redis`)
- **OpenSearch Service** domain (`plattr-prod-search`, 2x t3.medium.search)
- **Security groups**: EKS → Aurora:5432, EKS → ElastiCache:6379, EKS → OpenSearch:443
- **Cross-account ECR pull role** for pulling images from non-prod
- **Operator Helm chart** with `REDIS_ENDPOINT` and `OPENSEARCH_ENDPOINT` configured
- **production namespace** only (no staging/uat/preview)

### Customizing Prod Resources

| Context key | Default | Description |
|---|---|---|
| `eksClusterName` | `plattr-prod` | EKS cluster name |
| `auroraMinCapacity` | `1` | Aurora min ACU |
| `auroraMaxCapacity` | `8` | Aurora max ACU |
| `opensearchInstanceType` | `t3.medium.search` | OpenSearch instance type |
| `opensearchDataNodeCount` | `2` | OpenSearch data node count |

## Step 3: Set Up Cross-Account ECR Access

The prod account needs to pull container images from the non-prod ECR. The `PlattrProdInfraStack` creates the pull role automatically when `nonprodAccountId` is provided.

On the **non-prod side**, update the ECR repository policy to allow cross-account access:

```bash
# Switch to non-prod account
export AWS_PROFILE=plattr-nonprod

# Add cross-account pull policy to ECR repos
aws ecr set-repository-policy \
  --repository-name plattr-apps \
  --policy-text '{
    "Version": "2012-10-17",
    "Statement": [{
      "Sid": "AllowProdAccountPull",
      "Effect": "Allow",
      "Principal": {"AWS": "arn:aws:iam::PROD_ACCOUNT_ID:root"},
      "Action": [
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:BatchCheckLayerAvailability"
      ]
    }]
  }'
```

Repeat for `plattr-operator` if deploying the operator image from non-prod ECR.

## Step 4: Configure CI/CD Cross-Account Deploy

Update the CI/CD stack in the **non-prod account** with the prod account ID:

```bash
export AWS_PROFILE=plattr-nonprod
cd packages/cdk

npx cdk deploy PlattrCicdStack \
  -c githubOrg=your-org \
  -c prodAccountId=PROD_ACCOUNT_ID
```

This grants the `plattr-ci-deploy-prod` role permission to `sts:AssumeRole` into the prod account.

### GitHub Secrets

Add these secrets to your GitHub repository:

| Secret | Value |
|--------|-------|
| `AWS_ROLE_ARN` | Non-prod CI deploy role ARN |
| `AWS_ROLE_ARN_PROD` | Prod CI deploy role ARN |

## Step 5: Verify the Deployment

```bash
# Switch to prod account
export AWS_PROFILE=plattr-prod

# Check EKS cluster
aws eks describe-cluster --name plattr-prod --query 'cluster.status'

# Configure kubectl
aws eks update-kubeconfig --name plattr-prod

# Verify operator is running
kubectl get pods -n plattr-system

# Check operator logs
kubectl logs -n plattr-system -l app.kubernetes.io/name=plattr-operator

# Verify managed service endpoints are configured
kubectl get deployment plattr-operator -n plattr-system -o jsonpath='{.spec.template.spec.containers[0].env}' | python3 -m json.tool

# Check production namespace exists
kubectl get ns production
```

## Step 6: Test a Production Deploy

Merge a PR to `main`. The GitHub Actions workflow will:

1. Build and push the image to ECR (non-prod account)
2. Deploy to staging → UAT (non-prod EKS)
3. After UAT approval, assume the prod deploy role
4. Apply the Application CR to the prod EKS cluster's `production` namespace
5. The prod operator reconciles using managed services

Check the deployment:

```bash
kubectl get applications -n production
kubectl get application my-app -n production -o yaml
```

## Troubleshooting

### Operator Can't Reach ElastiCache/OpenSearch

Check security group rules allow EKS cluster SG → service port:

```bash
# ElastiCache (port 6379)
aws ec2 describe-security-groups --group-ids <elasticache-sg-id> \
  --query 'SecurityGroups[0].IpPermissions'

# OpenSearch (port 443)
aws ec2 describe-security-groups --group-ids <opensearch-sg-id> \
  --query 'SecurityGroups[0].IpPermissions'
```

### Cross-Account ECR Pull Fails

Verify the ECR repository policy and the pull role:

```bash
# On non-prod
aws ecr get-repository-policy --repository-name plattr-apps

# On prod — test pull
aws ecr get-login-password --region ca-central-1 | docker login --username AWS --password-stdin NONPROD_ACCOUNT_ID.dkr.ecr.ca-central-1.amazonaws.com
```

### ConfigMap Not Created

Check operator logs for `[REDIS]` or `[SEARCH]` entries:

```bash
kubectl logs -n plattr-system -l app.kubernetes.io/name=plattr-operator | grep -E '\[REDIS\]|\[SEARCH\]'
```

Verify environment variables are set:

```bash
kubectl exec -n plattr-system deploy/plattr-operator -- env | grep -E 'REDIS_ENDPOINT|OPENSEARCH_ENDPOINT'
```
