# Step 1: Provision EKS Cluster + Aurora PostgreSQL

This tutorial walks you through creating the minimum infrastructure needed for the Plattr non-prod cluster. By the end, you'll have an EKS cluster and Aurora PostgreSQL database ready for the CDK operator stack.

## Prerequisites

Install these tools before starting:

```bash
# AWS CLI v2
aws --version   # needs 2.x

# Node.js
node --version  # needs 18+

# AWS CDK
npx cdk --version

# kubectl
kubectl version --client
```

Ensure your AWS credentials are configured:

```bash
aws sts get-caller-identity
```

You should see your account ID and ARN.

## Overview of What We're Creating

| Resource | Purpose |
|----------|---------|
| VPC with public/private subnets | Network isolation for EKS and Aurora |
| EKS cluster (1.33, Auto Mode) | Runs the Plattr operator and app workloads |
| OIDC provider | Enables IRSA (IAM Roles for Service Accounts) |
| Aurora PostgreSQL Serverless v2 | Database backend for the operator |
| Security group rule | Allows EKS pods to connect to Aurora |

---

## Deploy with CDK (Recommended)

The `PlattrInfraStack` provisions all of the above in a single `cdk deploy`.

### 1. Install dependencies

```bash
cd packages/cdk
npm install
```

### 2. Bootstrap CDK (first time only)

If you haven't used CDK in this account/region before:

```bash
npx cdk bootstrap aws://ACCOUNT_ID/ca-central-1
```

### 3. Deploy the infrastructure stack

```bash
npx cdk deploy PlattrInfraStack \
  -c useInfraStack=true \
  -c account=YOUR_ACCOUNT_ID \
  -c region=ca-central-1
```

This takes 20-30 minutes (EKS cluster creation is the bottleneck).

#### Optional context overrides

| Context key | Default | Description |
|-------------|---------|-------------|
| `eksClusterName` | `plattr-nonprod` | EKS cluster name |
| `auroraMinCapacity` | `0.5` | Aurora Serverless v2 min ACU |
| `auroraMaxCapacity` | `4` | Aurora Serverless v2 max ACU |

EKS Auto Mode manages compute automatically — no instance types or node counts to configure.

Example with overrides:

```bash
npx cdk deploy PlattrInfraStack \
  -c useInfraStack=true \
  -c account=123456789012 \
  -c region=us-east-1 \
  -c eksClusterName=plattr-dev \
  -c auroraMinCapacity=0.5 \
  -c auroraMaxCapacity=2
```

### 4. Verify the cluster

```bash
# Update kubeconfig (use the kubectl role ARN from stack outputs)
aws eks update-kubeconfig \
  --name plattr-nonprod \
  --region ca-central-1 \
  --role-arn <KubectlRoleArn from stack output>

kubectl get nodes
```

You should see nodes provisioned by EKS Auto Mode in `Ready` state.

### 5. Test Aurora connectivity

```bash
# Get the Aurora endpoint from stack outputs
AURORA_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name PlattrInfraStack \
  --query "Stacks[0].Outputs[?OutputKey=='AuroraEndpoint'].OutputValue" \
  --output text)

# Get the admin password from Secrets Manager
DB_PASSWORD=$(aws secretsmanager get-secret-value \
  --secret-id plattr/aurora-admin \
  --query "SecretString" --output text | jq -r '.password')

# Test from inside the cluster
kubectl run pg-test --rm -it --restart=Never \
  --image=postgres:16 \
  --env="PGPASSWORD=$DB_PASSWORD" \
  -- psql -h $AURORA_ENDPOINT -U plattr_admin -d plattr -c "SELECT version();"
```

You should see the PostgreSQL 16 version string.

### 6. Deploy the operator stack

With `useInfraStack=true`, the operator stack automatically picks up the infra stack outputs — no manual `-c` args needed for cluster/Aurora values:

```bash
npx cdk deploy PlattrOperatorStack \
  -c useInfraStack=true \
  -c account=YOUR_ACCOUNT_ID \
  -c region=ca-central-1 \
  -c baseDomain=nonprod.yourcompany.dev \
  -c hostedZoneId=Z0123456789
```

---

## Cost Estimate (Non-Prod)

| Resource | Approximate Monthly Cost |
|----------|-------------------------|
| EKS control plane + Auto Mode | ~$73 |
| Auto Mode compute (scales with workload) | varies |
| Aurora Serverless v2 (0.5 ACU min) | ~$44 |
| NAT Gateway | ~$32 |
| **Total (idle)** | **~$150/month** |

> With Auto Mode, compute scales to zero when no workloads are running. Set Aurora min capacity to 0 to further reduce idle costs.

---

## What's Next

Once you've verified everything, proceed to [Step 2: Deploy the CDK Operator Stack](platform-rollout-plan.md#step-2-deploy-the-cdk-operator-stack).

You'll need a **Route 53 hosted zone** for your base domain (e.g., `nonprod.yourcompany.dev`). If you don't have one, create it:

```bash
aws route53 create-hosted-zone \
  --name nonprod.yourcompany.dev \
  --caller-reference "plattr-$(date +%s)"
```

Then add the NS records to your parent domain's DNS.

---

## Appendix A: Manual Setup (Alternative)

If you prefer manual CLI commands or have existing infrastructure, follow the steps below instead of the CDK approach above.

### A1. Define your variables

```bash
export AWS_REGION="ca-central-1"
export CLUSTER_NAME="plattr-nonprod"
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
```

### A2. Create the EKS cluster with eksctl

```bash
eksctl create cluster \
  --name $CLUSTER_NAME \
  --region $AWS_REGION \
  --version 1.33 \
  --without-nodegroup \
  --with-oidc

# Enable Auto Mode
aws eks update-cluster-config \
  --name $CLUSTER_NAME \
  --region $AWS_REGION \
  --compute-config enabled=true,nodePools=system,general-purpose \
  --kubernetes-network-config '{"elasticLoadBalancing":{"enabled":true}}' \
  --storage-config '{"blockStorage":{"enabled":true}}'
```

This takes 15-20 minutes. The `--with-oidc` flag is critical — it enables IRSA which the operator stack requires. Auto Mode manages compute automatically.

### A3. Verify the cluster

```bash
kubectl get nodes
```

You should see nodes provisioned by EKS Auto Mode once workloads are scheduled.

### A4. Collect the cluster outputs

```bash
echo "Cluster Name: $CLUSTER_NAME"

# OIDC Provider ARN
export OIDC_PROVIDER_ARN=$(aws iam list-open-id-connect-providers \
  --query "OpenIDConnectProviderList[?ends_with(Arn, '$(aws eks describe-cluster \
    --name $CLUSTER_NAME \
    --region $AWS_REGION \
    --query "cluster.identity.oidc.issuer" \
    --output text | awk -F'/' '{print $NF}')')].[Arn]" \
  --output text)
echo "OIDC Provider ARN: $OIDC_PROVIDER_ARN"

# kubectl Role ARN
export KUBECTL_ROLE_ARN=$(aws cloudformation describe-stacks \
  --stack-name eksctl-${CLUSTER_NAME}-cluster \
  --region $AWS_REGION \
  --query "Stacks[0].Outputs[?OutputKey=='ARN'].OutputValue" \
  --output text 2>/dev/null)
if [ -z "$KUBECTL_ROLE_ARN" ]; then
  export KUBECTL_ROLE_ARN=$(aws sts get-caller-identity --query Arn --output text)
fi
echo "kubectl Role ARN: $KUBECTL_ROLE_ARN"
```

### A5. Get VPC and subnet IDs

```bash
export VPC_ID=$(aws eks describe-cluster \
  --name $CLUSTER_NAME \
  --region $AWS_REGION \
  --query "cluster.resourcesVpcConfig.vpcId" \
  --output text)

export PRIVATE_SUBNETS=$(aws ec2 describe-subnets \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=tag:aws:cloudformation:logical-id,Values=SubnetPrivate*" \
  --query "Subnets[*].SubnetId" \
  --output text)

export NODE_SG=$(aws eks describe-cluster \
  --name $CLUSTER_NAME \
  --region $AWS_REGION \
  --query "cluster.resourcesVpcConfig.clusterSecurityGroupId" \
  --output text)
```

### A6. Create Aurora PostgreSQL

```bash
# DB subnet group
SUBNET_LIST=$(echo $PRIVATE_SUBNETS | tr '\t' ' ')
aws rds create-db-subnet-group \
  --db-subnet-group-name plattr-nonprod-db \
  --db-subnet-group-description "Plattr non-prod Aurora subnets" \
  --subnet-ids $SUBNET_LIST \
  --region $AWS_REGION

# Security group
export AURORA_SG=$(aws ec2 create-security-group \
  --group-name plattr-aurora-sg \
  --description "Plattr Aurora PostgreSQL" \
  --vpc-id $VPC_ID \
  --region $AWS_REGION \
  --query "GroupId" \
  --output text)

# Allow EKS → Aurora on port 5432
aws ec2 authorize-security-group-ingress \
  --group-id $AURORA_SG \
  --protocol tcp \
  --port 5432 \
  --source-group $NODE_SG \
  --region $AWS_REGION

# Generate password
export DB_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)
echo "SAVE THIS PASSWORD: $DB_PASSWORD"

# Create Aurora cluster
aws rds create-db-cluster \
  --db-cluster-identifier plattr-nonprod \
  --engine aurora-postgresql \
  --engine-version 16.4 \
  --master-username plattr_admin \
  --master-user-password "$DB_PASSWORD" \
  --db-subnet-group-name plattr-nonprod-db \
  --vpc-security-group-ids $AURORA_SG \
  --serverless-v2-scaling-configuration MinCapacity=0.5,MaxCapacity=4 \
  --region $AWS_REGION

# Create instance
aws rds create-db-instance \
  --db-instance-identifier plattr-nonprod-instance-1 \
  --db-cluster-identifier plattr-nonprod \
  --db-instance-class db.serverless \
  --engine aurora-postgresql \
  --region $AWS_REGION

# Wait for it
aws rds wait db-instance-available \
  --db-instance-identifier plattr-nonprod-instance-1 \
  --region $AWS_REGION

# Get endpoint
export AURORA_ENDPOINT=$(aws rds describe-db-clusters \
  --db-cluster-identifier plattr-nonprod \
  --region $AWS_REGION \
  --query "DBClusters[0].Endpoint" \
  --output text)

# Create the plattr database
kubectl run pg-setup --rm -it --restart=Never \
  --image=postgres:16 \
  --env="PGPASSWORD=$DB_PASSWORD" \
  -- psql -h $AURORA_ENDPOINT -U plattr_admin -d postgres -c "CREATE DATABASE plattr;"
```

### A7. Deploy operator stack with manual context args

```bash
cd packages/cdk
npx cdk deploy PlattrOperatorStack \
  -c eksClusterName=$CLUSTER_NAME \
  -c kubectlRoleArn=$KUBECTL_ROLE_ARN \
  -c oidcProviderArn=$OIDC_PROVIDER_ARN \
  -c auroraEndpoint=$AURORA_ENDPOINT \
  -c auroraSgId=$AURORA_SG \
  -c baseDomain=nonprod.yourcompany.dev \
  -c hostedZoneId=Z0123456789
```

---

## Appendix B: Creating a Dedicated kubectl IAM Role

If you want a dedicated role instead of using your current identity:

```bash
TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::${ACCOUNT_ID}:root" },
    "Action": "sts:AssumeRole"
  }]
}
EOF
)

aws iam create-role \
  --role-name plattr-kubectl-role \
  --assume-role-policy-document "$TRUST_POLICY"

aws iam attach-role-policy \
  --role-name plattr-kubectl-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonEKSClusterPolicy

eksctl create iamidentitymapping \
  --cluster $CLUSTER_NAME \
  --region $AWS_REGION \
  --arn arn:aws:iam::${ACCOUNT_ID}:role/plattr-kubectl-role \
  --group system:masters \
  --username plattr-admin

export KUBECTL_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/plattr-kubectl-role"
```
