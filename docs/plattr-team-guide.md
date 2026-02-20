# Plattr Team Guide

This guide covers deploying, operating, and maintaining Plattr. It assumes familiarity with Kubernetes, AWS, and infrastructure tooling.

## Prerequisites

- **AWS CLI** configured with admin-level credentials
- **AWS CDK** v2 — `npm install -g aws-cdk`
- **kubectl** connected to your EKS cluster
- **Helm** v3
- **Node.js** 18+ and npm
- **Docker** (for CDK asset bundling)

## Infrastructure Overview

```
AWS Account
├── EKS Cluster
│   ├── plattr-system namespace
│   │   ├── Plattr Operator (Deployment)
│   │   ├── Keycloak (StatefulSet, 2 replicas)
│   │   ├── cert-manager
│   │   ├── external-dns
│   │   └── ingress-nginx (NLB)
│   ├── production namespace
│   ├── staging namespace
│   ├── uat namespace
│   └── preview-* namespaces (dynamic)
├── Aurora PostgreSQL (shared, schema-per-app)
├── S3 (bucket-per-app)
├── ECR
│   ├── plattr-operator (operator image)
│   └── plattr-apps (all app images)
├── Secrets Manager
│   └── plattr/db-admin (Aurora admin creds)
└── Route 53 (DNS, managed by external-dns)
```

## CDK Deployment

The infrastructure is defined in three CDK stacks. All commands run from `packages/cdk`.

```bash
cd packages/cdk
npm install
```

### Deployment Modes

There are two ways to deploy Plattr depending on whether you want CDK to manage the foundational infrastructure (VPC, EKS, Aurora) or you're bringing your own.

#### Option A: CDK-managed infrastructure (recommended for new environments)

Set `-c useInfraStack=true` and CDK provisions everything end-to-end. The `PlattrInfraStack` creates the VPC, EKS cluster, and Aurora database, then wires them directly into the operator stack — no manual ARN/endpoint copying required.

```bash
# First-time bootstrap (once per account/region)
npx cdk bootstrap aws://ACCOUNT_ID/ca-central-1

# Deploy infra + operator together
npx cdk deploy PlattrInfraStack PlattrOperatorStack \
  -c useInfraStack=true \
  -c account=ACCOUNT_ID \
  -c region=ca-central-1 \
  -c baseDomain=nonprod.yourcompany.dev \
  -c hostedZoneId=Z0123456789
```

CDK handles cross-stack references automatically. The infra stack exports the cluster name, OIDC provider ARN, Aurora endpoint, and security group ID — the operator stack consumes them without any manual input.

#### Option B: Bring your own infrastructure

If you already have an EKS cluster and Aurora database (or manage them outside CDK), keep the default mode and pass the values via `-c` context flags:

```bash
npx cdk deploy PlattrOperatorStack \
  -c eksClusterName=my-eks-cluster \
  -c kubectlRoleArn=arn:aws:iam::123456789012:role/my-kubectl-role \
  -c oidcProviderArn=arn:aws:iam::123456789012:oidc-provider/oidc.eks... \
  -c auroraEndpoint=my-aurora.cluster-xxx.ca-central-1.rds.amazonaws.com \
  -c auroraSgId=sg-xxxxx \
  -c baseDomain=nonprod.yourcompany.dev \
  -c hostedZoneId=Z0123456789
```

See [Step 1: Manual Setup](step1-eks-aurora-setup.md#appendix-a-manual-setup-alternative) for how to create these resources with `eksctl` and AWS CLI.

### Stack 1: PlattrInfraStack

Provisions the foundational AWS infrastructure. Only deployed when using `-c useInfraStack=true`.

```bash
# Preview changes
npx cdk diff PlattrInfraStack -c useInfraStack=true

# Deploy
npx cdk deploy PlattrInfraStack -c useInfraStack=true
```

**What it creates:**
- **VPC** with public/private subnets across 2 AZs, 1 NAT gateway
- **EKS cluster** (K8s 1.31) with a managed node group (t3.large, 2-4 nodes, ON_DEMAND)
- **kubectl IAM role** for CDK and manual cluster access
- **OIDC provider** for IRSA (auto-enabled by the EKS construct)
- **Aurora Serverless v2** (PostgreSQL 16.4, 0.5-4 ACU scaling, `plattr` default database)
- **Security group rule** allowing EKS cluster SG → Aurora on port 5432

**Stack outputs:**

| Output | Description |
|--------|-------------|
| `ClusterName` | EKS cluster name |
| `KubectlRoleArn` | IAM role for kubectl access |
| `OidcProviderArn` | OIDC provider ARN for IRSA |
| `AuroraEndpoint` | Aurora cluster writer endpoint |
| `AuroraSecurityGroupId` | Aurora security group ID |

**Customizable props:**

| Context key | Default | Description |
|---|---|---|
| `eksClusterName` | `plattr-nonprod` | EKS cluster name |
| `nodeInstanceType` | `t3.large` | EC2 instance type for worker nodes |
| `nodeMinSize` | `2` | Minimum node group size |
| `nodeMaxSize` | `4` | Maximum node group size |
| `nodeDesiredSize` | `2` | Desired node group size |
| `auroraMinCapacity` | `0.5` | Aurora Serverless v2 min ACU |
| `auroraMaxCapacity` | `4` | Aurora Serverless v2 max ACU |

### Stack 2: PlattrOperatorStack

Deploys the operator, add-ons, CRDs, and environment namespaces.

```bash
# Review what will be deployed
npx cdk diff PlattrOperatorStack

# Deploy
npx cdk deploy PlattrOperatorStack
```

**What it creates:**
- **plattr-system namespace** with CRDs (Application, PreviewEnvironment)
- **Secrets Manager secret** (`plattr/db-admin`) for Aurora admin credentials
- **ECR repository** (`plattr-operator`) with 25-image retention
- **IRSA role** for the operator ServiceAccount with permissions for S3, Secrets Manager, and STS
- **Operator Helm release** with configuration (DB secret ARN, host, region, base domain, Keycloak URL)
- **Environment namespaces** (staging, uat, production) with resource quotas
- **Add-ons** (all enabled by default):
  - cert-manager + Let's Encrypt ClusterIssuer
  - external-dns with Route 53
  - ingress-nginx with AWS NLB
  - Keycloak 26.0 (2 replicas, external PostgreSQL, HTTPS Ingress)

**Additional context flags (operator stack):**

| Key | Default | Description |
|---|---|---|
| `baseDomain` | `platform.company.dev` | Base domain for app ingresses |
| `hostedZoneId` | — | Route 53 hosted zone ID |
| `installCertManager` | `true` | Install cert-manager |
| `installExternalDns` | `true` | Install external-dns |
| `installIngressNginx` | `true` | Install ingress-nginx |
| `installKeycloak` | `true` | Install Keycloak |

### Stack 3: PlattrCicdStack

Sets up CI/CD roles for GitHub Actions.

```bash
npx cdk deploy PlattrCicdStack
```

**What it creates:**
- **GitHub OIDC provider** for keyless authentication
- **ECR repository** (`plattr-apps`) with 50-image retention
- **CI Deploy Role** — non-prod deployments from any branch (ECR push + EKS describe)
- **Prod Deploy Role** — production deployments from main branch only

**Context flags:**

| Key | Default | Description |
|---|---|---|
| `githubOrg` | — | GitHub organization name |
| `githubRepoFilter` | — | Optional repo name filter |

## Operator Management

### How the Operator Works

The operator watches two Custom Resource types:

1. **Application** — represents a deployed app. The operator reconciles it into database schemas, S3 buckets, Keycloak realms, Deployments, Services, Ingresses, and HPAs.
2. **PreviewEnvironment** — represents a PR preview. The operator creates an isolated namespace with its own database schema, storage, and workload.

Reconciliation is triggered by Kubernetes informers (watch events). The operator uses generation-based tracking to avoid infinite loops from status updates.

### Operator Configuration

The operator reads configuration from environment variables:

| Variable | Description | Required |
|---|---|---|
| `DB_ADMIN_URL` | PostgreSQL admin connection string (dev mode) | One of these |
| `DB_SECRET_ARN` | AWS Secrets Manager ARN (prod mode) | required |
| `DB_HOST` | Aurora cluster endpoint | Yes |
| `AWS_REGION` | AWS region | Yes |
| `BASE_DOMAIN` | Plattr base domain | Yes |
| `KEYCLOAK_URL` | Keycloak base URL | If auth enabled |
| `KEYCLOAK_ADMIN_USER` | Keycloak admin username | If auth enabled |
| `KEYCLOAK_ADMIN_PASSWORD` | Keycloak admin password | If auth enabled |
| `LEADER_ELECTION` | Enable leader election (`true`/`false`) | No (default: false) |
| `LEASE_NAMESPACE` | Namespace for leader lease | If leader election on |
| `AWS_ENDPOINT_URL` | Override AWS endpoint (for LocalStack) | No |

### Viewing Operator Logs

```bash
kubectl logs -n plattr-system -l app=plattr-operator -f --all-containers
```

### Leader Election

For high-availability (multiple operator replicas), enable leader election:

```yaml
env:
  - name: LEADER_ELECTION
    value: "true"
  - name: LEASE_NAMESPACE
    value: plattr-system
```

The operator creates a `Lease` resource (`plattr-operator-leader`). Only the leader processes reconciliation events. Lease duration is 15 seconds with 5-second renewal intervals.

### Scaling the Operator

The operator runs as a single Deployment. With leader election enabled, you can run multiple replicas for failover:

```bash
kubectl scale deployment plattr-operator -n plattr-system --replicas=2
```

Only the leader processes events; standbys take over if the leader's lease expires.

## CRD Management

### Installing CRDs

```bash
kubectl apply -f manifests/crds/application.yaml
kubectl apply -f manifests/crds/preview-environment.yaml
```

### Verifying CRDs

```bash
kubectl get crd applications.platform.internal
kubectl get crd previewenvironments.platform.internal
```

### Creating an Application

```yaml
apiVersion: platform.internal/v1alpha1
kind: Application
metadata:
  name: my-frontend
  namespace: default
spec:
  repository: github.com/myorg/my-frontend
  framework: nextjs
  environment: production
  imageRef: 123456789.dkr.ecr.us-east-1.amazonaws.com/plattr-apps:my-frontend-abc123
  database:
    enabled: true
  storage:
    enabled: true
    buckets:
      - name: uploads
        public: false
  auth:
    enabled: true
    providers: [google, github]
  scaling:
    min: 2
    max: 20
    targetCPU: 70
```

```bash
kubectl apply -f my-app.yaml
```

### Checking Application Status

```bash
# Summary
kubectl get applications

# Detailed status
kubectl get application my-frontend -o yaml

# Status conditions
kubectl get application my-frontend -o jsonpath='{.status.conditions}' | python3 -m json.tool
```

Status phases: `Pending` → `Provisioning` → `Running` (or `Failed`)

See the full [CRD Reference](reference/crds.md).

## Supporting Add-Ons

### cert-manager

Provides automatic TLS certificates via Let's Encrypt.

```bash
# Verify cert-manager is running
kubectl get pods -n cert-manager

# Check ClusterIssuer
kubectl get clusterissuer letsencrypt-prod

# Debug certificate issues
kubectl get certificates -A
kubectl describe certificate <name> -n <namespace>
```

### external-dns

Automatically creates DNS records in Route 53 from Ingress resources.

```bash
# Verify external-dns is running
kubectl get pods -n kube-system -l app=external-dns

# Check logs for DNS sync
kubectl logs -n kube-system -l app=external-dns
```

### ingress-nginx

Routes external traffic to services via an AWS Network Load Balancer.

```bash
# Verify ingress controller
kubectl get pods -n ingress-nginx

# Check NLB
kubectl get svc -n ingress-nginx ingress-nginx-controller

# List all Ingress resources
kubectl get ingress -A
```

### Keycloak

Managed authentication provider running on EKS.

```bash
# Check Keycloak pods
kubectl get pods -n plattr-system -l app=keycloak

# Access admin console (port-forward)
kubectl port-forward -n plattr-system svc/keycloak 8443:443
# Open https://localhost:8443/admin
```

## Monitoring

### Prometheus Metrics

The operator exposes Prometheus metrics on port 9090 (default Express server):

| Metric | Type | Description |
|---|---|---|
| `application_phase` | Gauge | Current phase of each Application (labeled by name, namespace, phase) |
| `reconcile_total` | Counter | Total reconciliation count (labeled by name, result: success/failure) |

### Health Checks

The operator exposes a health endpoint. Check it with:

```bash
kubectl exec -n plattr-system deploy/plattr-operator -- curl -s localhost:9090/healthz
```

### Resource Quotas

Each environment namespace has resource quotas (configured in CDK):

```bash
kubectl get resourcequota -n production
kubectl get resourcequota -n staging
kubectl get resourcequota -n uat
```

## Troubleshooting

### Application Stuck in "Provisioning"

1. Check operator logs for errors:
   ```bash
   kubectl logs -n plattr-system -l app=plattr-operator --tail=100
   ```

2. Check Application conditions:
   ```bash
   kubectl get application my-app -o jsonpath='{.status.conditions}' | python3 -m json.tool
   ```

3. Common causes:
   - **DatabaseReady: False** — Aurora connectivity issue, check DB_ADMIN_URL or DB_SECRET_ARN
   - **StorageReady: False** — S3/IAM permissions issue, check operator IRSA role
   - **AuthReady: False** — Keycloak unreachable, check Keycloak pods
   - **DeploymentReady: False** — Pods failing to start, check `kubectl describe pod`

### Application Stuck in "Failed"

The operator retries up to 3 times with exponential backoff (1s, 2s, 4s). If it fails:

1. Fix the underlying issue
2. Trigger re-reconciliation by touching the spec:
   ```bash
   kubectl patch application my-app --type=merge -p '{"spec":{"scaling":{"min":2}}}'
   ```

### Preview Environment Not Cleaning Up

The TTL controller runs every 5 minutes. Check:

```bash
# List previews with expiry
kubectl get previewenvironments -o custom-columns=NAME:.metadata.name,EXPIRES:.status.expiresAt

# Manually delete
kubectl delete previewenvironment my-app-pr-42
```

### PostgREST Sidecar Not Working

1. Check both containers in the pod:
   ```bash
   kubectl get pods -l app.kubernetes.io/name=my-app
   kubectl logs <pod> -c postgrest
   ```

2. Common issues:
   - **Connection refused** — database schema or role doesn't exist yet (migration not run)
   - **Empty response** — no tables granted to the `_anon` role
   - **Schema not found** — schema name mismatch (check `PGRST_DB_SCHEMAS` env var)

### Database Connection Issues

```bash
# Check the DB secret exists
kubectl get secret my-app-db -n production -o yaml

# Test connectivity from a pod
kubectl run -it --rm pg-test --image=postgres:14 -- psql "$(kubectl get secret my-app-db -n production -o jsonpath='{.data.DATABASE_URL}' | base64 -d)"
```

### Operator Crash Loop

```bash
# Check events
kubectl get events -n plattr-system --sort-by='.lastTimestamp'

# Check resource limits
kubectl describe pod -n plattr-system -l app=plattr-operator
```

Common causes:
- Missing IRSA role (check ServiceAccount annotation)
- Invalid DB_SECRET_ARN
- Kubernetes API permissions (check RBAC)

## Day-2 Operations

### Upgrading the Operator

1. Build and push new operator image to ECR
2. Update the Helm values or CDK context with the new image tag
3. Deploy:
   ```bash
   npx cdk deploy PlattrOperatorStack
   ```
   Or update the Helm release directly:
   ```bash
   helm upgrade plattr-operator ./chart -n plattr-system --set image.tag=new-version
   ```

### Upgrading PostgREST

The PostgREST version is pinned in the operator code (`postgrest/postgrest:v12.2.3`). To upgrade:

1. Update the version in `packages/operator/src/reconcilers/workload.ts`
2. Rebuild and deploy the operator
3. All apps will get the new PostgREST version on next reconciliation

### Database Backups

Aurora handles automated backups. For manual snapshots:

```bash
aws rds create-db-cluster-snapshot \
  --db-cluster-identifier plattr-aurora \
  --db-cluster-snapshot-identifier manual-$(date +%Y%m%d)
```

### Scaling Infrastructure

**More app replicas:** Adjust `scaling.min` and `scaling.max` in the Application spec. HPA handles the rest.

**More Aurora capacity:** Scale through AWS console or CDK.

**More Keycloak capacity:** Scale the StatefulSet:
```bash
kubectl scale statefulset keycloak -n plattr-system --replicas=3
```

### Adding a New Environment

1. Add the namespace in CDK (`PlattrOperatorStack`)
2. Deploy: `npx cdk deploy PlattrOperatorStack`
3. Update the CLI's `resolveEnv()` function to map the new environment name to namespace
4. Update CI/CD workflows to support the new environment

### Rotating Database Credentials

1. Update the secret in AWS Secrets Manager
2. Restart the operator to pick up new credentials:
   ```bash
   kubectl rollout restart deployment plattr-operator -n plattr-system
   ```
3. App-level credentials (per-schema roles) are generated by the operator and stored in Kubernetes Secrets. To rotate, delete the Secret and let the operator recreate it:
   ```bash
   kubectl delete secret my-app-db -n production
   # Operator will detect the missing Secret and recreate it with new credentials
   ```
