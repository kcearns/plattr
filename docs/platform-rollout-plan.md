# Plattr Platform Rollout Plan

## Current State

The local developer workflow (`plattr dev` / `plattr deploy local`) is solid. The code for the platform side is largely written — CDK stacks, operator, Helm chart, Dagger pipeline, CRDs — but there are gaps in the **glue** that connects a GitHub push to a running deployment on a real cluster.

## The End-to-End Flow (and where it breaks)

```
Developer pushes to GitHub
  → GitHub Actions workflow fires
  → AWS OIDC auth (CI/CD stack role)
  → Dagger: test → build → push image to ECR
  → [STUB] kubectl apply Application CR     ← not implemented
  → Operator detects CR, reconciles everything
  → App is live
```

The build/push part works. The deploy steps are `echo` placeholders.

## Recommended Order of Operations

### Step 1: Provision EKS cluster + Aurora PostgreSQL

The CDK stacks **import** an existing cluster — they don't create one. You need:

- An EKS cluster (with OIDC provider enabled for IRSA)
- An Aurora PostgreSQL instance (the operator needs `DB_ADMIN_URL`)
- Collect: cluster name, kubectl role ARN, OIDC provider ARN, Aurora endpoint, security group ID

See [Step 1 Tutorial](step1-eks-aurora-setup.md) for exact commands.

### Step 2: Deploy the CDK Operator Stack

```bash
cd packages/cdk
npx cdk deploy PlattrOperatorStack \
  -c eksClusterName=<cluster> \
  -c kubectlRoleArn=<arn> \
  -c oidcProviderArn=<arn> \
  -c auroraEndpoint=<endpoint> \
  -c auroraSgId=<sg-id> \
  -c baseDomain=<domain> \
  -c hostedZoneId=<zone-id>
```

This installs CRDs, creates the `plattr-system` namespace, sets up IRSA, deploys the operator via Helm, creates environment namespaces with quotas, and optionally installs cert-manager, external-dns, ingress-nginx, and Keycloak.

**Prerequisite**: Build and push the operator image to ECR first (no automation for this yet).

### Step 3: Deploy the CDK CI/CD Stack

```bash
npx cdk deploy PlattrCicdStack -c githubOrg=<your-org>
```

Creates the GitHub OIDC provider and IAM roles for GitHub Actions to push to ECR and interact with EKS.

### Step 4: Fill in the deploy stubs in the workflow template

The file `manifests/templates/plattr-deploy.yml` has working build/test jobs but the deploy steps (preview, staging, UAT, production) are all `echo` placeholders. These need `kubectl apply` commands to create/update Application CRs on the cluster.

## Known Gaps

| Gap | Impact |
|-----|--------|
| **Deploy steps are stubs** in the GitHub Actions template | No actual deployment happens after image push |
| **No operator image CI/CD** | Operator image must be manually built and pushed to ECR |
| **Keycloak DB secret** not created by CDK | Keycloak won't start without it |
| **`KEYCLOAK_ADMIN_PASSWORD`** not wired in Helm deployment template | Operator can't manage Keycloak realms |
| **No `plattr init` command** | The workflow template can't be scaffolded into developer repos |
| **Redis/OpenSearch reconcilers** not implemented | CRD fields exist but operator ignores them |
