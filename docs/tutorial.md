# End-to-End Tutorial

This tutorial walks through a complete Plattr workflow from scratch. A platform engineer sets up a non-prod cluster on AWS, then a developer builds a Next.js app and deploys it.

**Conventions used throughout:**

| Placeholder | Example value |
|---|---|
| AWS Account ID | `111122223333` |
| AWS Region | `us-east-1` |
| Base domain | `platform.example.dev` |
| Route 53 Hosted Zone ID | `Z0EXAMPLE12345` |
| GitHub org | `acme-eng` |
| App name | `my-app` |

---

## Part 1: Platform Engineer — Setting Up the Cluster

### 1.1 Prerequisites

Install the following before proceeding:

| Tool | Version | Purpose |
|---|---|---|
| Node.js | 18+ | Runs CDK and CLI |
| Docker | Latest | Container builds, Kind cluster |
| AWS CLI | v2 | AWS authentication |
| AWS CDK | v2 | Infrastructure deployment |
| kubectl | 1.28+ | Kubernetes interaction |
| Helm | v3 | Chart installations |

Ensure your AWS CLI is configured with credentials that have administrator access:

```bash
aws sts get-caller-identity
# Should return your account ID (e.g. 111122223333)
```

### 1.2 DNS Setup

Create a Route 53 hosted zone for your base domain. Apps will be accessible at `{appName}.{env}.{baseDomain}` (e.g. `my-app.staging.platform.example.dev`).

1. In the AWS Console, go to **Route 53 → Hosted zones → Create hosted zone**
2. Enter your domain (e.g. `platform.example.dev`) and select **Public hosted zone**
3. Copy the NS records and add them to your domain registrar
4. Note the **Hosted Zone ID** (e.g. `Z0EXAMPLE12345`) — you'll need it later

Verify DNS delegation is working:

```bash
dig NS platform.example.dev
# Should return the Route 53 NS records
```

### 1.3 Clone and Install

```bash
git clone https://github.com/acme-eng/plattr.git
cd plattr
npm install
```

### 1.4 Initialize Infrastructure Configuration

Run the interactive wizard to generate `packages/cdk/cdk.json`:

```bash
plattr infra init
```

Walk through each prompt:

**Environment type:**

```
? Environment type: Non-prod (staging/dev)
```

Choose `Non-prod (staging/dev)` — this creates staging and UAT environments on a single EKS cluster.

**Common settings:**

```
? AWS Account ID?  111122223333
? AWS Region?      us-east-1
? Base domain?     platform.example.dev
? Route 53 Hosted Zone ID?  Z0EXAMPLE12345
? GitHub organization name?  acme-eng
? GitHub repo filter?  (press Enter to skip)
```

The GitHub org is used for OIDC federation — CI/CD workflows in repos under this org can authenticate to AWS without static credentials. The repo filter is optional; leave it blank to allow all repos in the org.

**Add-ons:**

```
? Install cert-manager?    Yes
? Install external-dns?    Yes
? Install ingress-nginx?   Yes
? Install Keycloak?        Yes
```

All default to `Yes`. These provide TLS certificates (Let's Encrypt), automatic DNS records, an ingress controller, and authentication respectively.

**Infrastructure mode:**

```
? Infrastructure mode: CDK-managed (new VPC + EKS + Aurora)
```

Choose `CDK-managed` to have CDK create the VPC, EKS cluster, and Aurora database for you. The `Existing infrastructure` option is for connecting to an EKS cluster you already have.

**Cluster settings:**

```
? EKS cluster name?         plattr-nonprod
? Availability zones?       (press Enter for auto)
? Aurora min ACU?           0.5
? Aurora max ACU?           4
```

EKS Auto Mode handles compute automatically — no instance types or node counts to configure. For a tutorial or dev/test environment, Aurora Serverless at 0.5–4 ACUs keeps costs low.

The wizard writes `packages/cdk/cdk.json` and prints next steps:

```
Wrote packages/cdk/cdk.json

Next steps:
  cd packages/cdk
  npm install
  npx cdk bootstrap aws://111122223333/us-east-1
  npx cdk deploy PlattrInfraStack PlattrOperatorStack PlattrCicdStack
```

### 1.5 Bootstrap CDK

CDK bootstrap creates a staging S3 bucket and IAM roles that CDK uses to deploy resources:

```bash
cd packages/cdk
npx cdk bootstrap aws://111122223333/us-east-1
```

This only needs to run once per account/region combination.

### 1.6 Deploy the Stacks

Deploy all three stacks:

```bash
npx cdk deploy PlattrInfraStack PlattrOperatorStack PlattrCicdStack
```

CDK will show you the resources it plans to create and ask for confirmation. Type `y` to proceed.

**What gets created (~30–45 minutes):**

| Stack | What it creates |
|---|---|
| `PlattrInfraStack` | VPC (public/private subnets, NAT gateway), EKS cluster (Kubernetes 1.33, Auto Mode), Aurora Serverless v2 (PostgreSQL 16.4) |
| `PlattrOperatorStack` | `plattr-system` namespace, CRDs (`Application`, `PreviewEnvironment`), operator Helm release, ECR repo (`plattr-operator`), IRSA role, environment namespaces (`staging`, `uat`, `production`), cert-manager + Let's Encrypt, external-dns, ingress-nginx (AWS NLB), Keycloak |
| `PlattrCicdStack` | GitHub OIDC provider, ECR repo (`plattr-apps`), CI/CD deploy IAM roles |

### 1.7 Verify the Cluster

Update your kubeconfig to point at the new cluster:

```bash
aws eks update-kubeconfig --name plattr-nonprod --region us-east-1
```

Check that nodes are ready:

```bash
kubectl get nodes
# NAME                          STATUS   ROLES    AGE   VERSION
# ip-10-0-1-xx.ec2.internal    Ready    <none>   10m   v1.33.x
# ip-10-0-2-xx.ec2.internal    Ready    <none>   10m   v1.33.x
```

Check the operator is running:

```bash
kubectl get pods -n plattr-system
# NAME                               READY   STATUS    RESTARTS   AGE
# plattr-operator-xxxxxxxxxx-xxxxx   1/1     Running   0          5m
```

Check environment namespaces exist:

```bash
kubectl get ns staging uat production
# NAME         STATUS   AGE
# staging      Active   5m
# uat          Active   5m
# production   Active   5m
```

Check add-ons:

```bash
kubectl get pods -n cert-manager
kubectl get pods -n ingress-nginx
kubectl get pods -n external-dns
kubectl get pods -n keycloak
```

Your cluster is ready. Developers can now deploy apps to it.

### 1.8 Tear Down (When Done)

To remove all AWS resources when you're finished with this tutorial:

```bash
cd packages/cdk
npx cdk destroy --all
```

This deletes the EKS cluster, VPC, Aurora database, and all associated resources. Aurora has a `RETAIN` removal policy, so the database cluster will be retained as a safety measure — delete it manually from the RDS console if you want a full cleanup.

---

## Part 2: Developer — Building and Deploying a Next.js App

### 2.1 Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node.js | 18+ | Runtime |
| Docker | Latest | Container builds, local cluster |
| Kind | Latest | Local Kubernetes |
| kubectl | 1.28+ | Kubernetes interaction |
| Dagger CLI | Latest | Build pipeline |
| Plattr CLI | Latest | `npm install -g @plattr/cli` |

### 2.2 Scaffold the App

Create a new Next.js app and initialize Plattr:

```bash
npx create-next-app@latest my-app
cd my-app
plattr init
```

`plattr init` asks a series of questions:

```
? App name?        my-app
? Framework?       nextjs
? Enable database? Yes
? Enable storage?  Yes
? Enable auth?     Yes
? Enable Redis?    No
? Enable OpenSearch? No
```

This creates two files:

- **`plattr.yaml`** — declares what your app needs:

```yaml
name: my-app
framework: nextjs

database:
  enabled: true

storage:
  enabled: true
  buckets:
    - name: uploads
      public: false

auth:
  enabled: true
  providers:
    - google
    - github

local:
  port: 3000
```

- **`.github/workflows/plattr-deploy.yml`** — CI/CD workflow for automatic deployment on push

### 2.3 Start Local Development

Start the local infrastructure:

```bash
plattr dev
```

This creates a Kind cluster, starts containerized services, and writes connection details to `.plattr/my-app.env`.

Source the environment variables and start your dev server:

```bash
source .plattr/my-app.env
npx next dev
```

Your app is now running at `http://localhost:3000` with all backing services available.

### 2.4 What's Running Locally

`plattr dev` starts these services in the Kind cluster and port-forwards them:

| Service | Port | Description |
|---|---|---|
| PostgreSQL | 5432 | App database (schema: `staging_my_app`) |
| PostgREST | 3001 | Auto-generated REST API over your database |
| MinIO | 9000 (API), 9001 (Console) | S3-compatible object storage |
| Keycloak | 8080 | Authentication / identity provider |
| Redis | 6379 | In-memory cache (if enabled) |
| OpenSearch | 9200 | Search engine (if enabled) |
| OpenSearch Dashboards | 5601 | Search UI (if enabled) |

### 2.5 Use the Database

Connect to the local database:

```bash
plattr db shell
# Connects to PostgreSQL as the admin user
```

Create a migration. For example, using Prisma:

```bash
npx prisma init
```

Edit `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model Task {
  id        Int      @id @default(autoincrement())
  title     String
  done      Boolean  @default(false)
  createdAt DateTime @default(now())
}
```

Run the migration:

```bash
plattr db migrate --engine prisma
```

The `Task` table is now available through PostgREST at `http://localhost:3001/task`:

```bash
# Create a task
curl -X POST http://localhost:3001/task \
  -H "Content-Type: application/json" \
  -d '{"title": "Try Plattr", "done": false}'

# List tasks
curl http://localhost:3001/task
```

In production, PostgREST runs as a sidecar container and is accessible at `/api/rest` on your app's domain.

### 2.6 Run Tests

Plattr auto-detects your test runner (Vitest, Jest, RSpec, or Minitest):

```bash
plattr test
```

For CI-style ephemeral tests (runs in a Dagger container):

```bash
plattr test --ci
```

### 2.7 Full Local Pipeline

Build, scan, and deploy to your local Kind cluster:

```bash
plattr deploy local
```

This runs through the full pipeline:

1. **Test** — runs your test suite
2. **Build** — creates a production container image
3. **Push** — pushes to the local Kind registry
4. **Scan** — runs Trivy vulnerability scan
5. **Deploy** — applies Kubernetes resources to the Kind cluster

Skip steps with flags:

```bash
plattr deploy local --skip-tests --skip-scan
```

Once deployed, check your app's status:

```bash
plattr status
# Phase: Running
# Conditions:
#   DatabaseReady:   True
#   StorageReady:    True
#   AuthReady:       True
#   DeploymentReady: True
#   IngressReady:    True
```

View logs (includes PostgREST sidecar output):

```bash
plattr logs -f
```

To remove the local deployment:

```bash
plattr undeploy local
```

### 2.8 Deploy to the Cluster

With the CI/CD stack deployed (Part 1), pushing to GitHub triggers automatic deployment.

Commit and push your app:

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/acme-eng/my-app.git
git push -u origin main
```

The `.github/workflows/plattr-deploy.yml` workflow runs automatically:

1. Authenticates to AWS via GitHub OIDC (no static credentials)
2. Builds a production container image
3. Pushes to the `plattr-apps` ECR repository
4. Runs Trivy security scan
5. Applies the `Application` custom resource to the EKS cluster
6. The operator reconciles: creates the database schema, S3 bucket, Keycloak client, Deployment, Service, and Ingress

Deployments go to **staging** by default. Merges to `main` can be promoted to production.

### 2.9 Verify the Deployment

Check the deployment status from the CLI:

```bash
plattr status --env staging
```

Or directly via kubectl:

```bash
kubectl get application my-app -n staging
```

Once all conditions are `True`, your app is live at:

```
https://my-app.staging.platform.example.dev
```

The auto-generated REST API is available at:

```
https://my-app.staging.platform.example.dev/api/rest
```

### 2.10 Preview Environments

When a pull request is opened, Plattr creates a preview environment automatically. You can also create one locally:

```bash
plattr preview start --pr 42
```

Preview environments get their own:

- Database schema (`preview_my_app_pr_42`)
- S3 bucket prefix
- Keycloak client
- Ingress at `my-app-pr-42.staging.platform.example.dev`

List active previews:

```bash
plattr preview list
```

Preview environments are cleaned up automatically after 72 hours of inactivity.

### 2.11 Clean Up

**Local cleanup:**

```bash
plattr infra destroy
```

This deletes the Kind cluster and the local Docker registry.

**AWS cleanup** (from the Plattr repo):

```bash
cd packages/cdk
npx cdk destroy --all
```

---

## Summary

| Step | Command | Who |
|---|---|---|
| Initialize config | `plattr infra init` | Platform engineer |
| Bootstrap CDK | `npx cdk bootstrap aws://ACCOUNT/REGION` | Platform engineer |
| Deploy stacks | `npx cdk deploy PlattrInfraStack PlattrOperatorStack PlattrCicdStack` | Platform engineer |
| Scaffold app | `npx create-next-app@latest my-app && plattr init` | Developer |
| Local dev | `plattr dev` | Developer |
| Run tests | `plattr test` | Developer |
| Local deploy | `plattr deploy local` | Developer |
| Remote deploy | `git push` (triggers CI/CD) | Developer |
| Tear down | `npx cdk destroy --all` | Platform engineer |

## Next Steps

- [Developer Guide](developer-guide.md) — detailed reference for all developer workflows
- [Plattr Team Guide](plattr-team-guide.md) — operating and troubleshooting the platform
- [CLI Reference](reference/cli.md) — complete command reference
- [plattr.yaml Reference](reference/plattr-yaml.md) — all configuration options
- [Architecture Deep-Dive](reference/architecture.md) — how Plattr works under the hood
