# Plattr

> **Alpha software** — This project is under active development and not yet production-ready. APIs, configuration formats, and behavior may change without notice. Use at your own risk.

An internal developer platform that gives teams a Vercel-like experience on top of Kubernetes. Define your app in a `plattr.yaml`, run `plattr dev` locally, push to deploy. Plattr handles databases, object storage, authentication, auto-generated REST APIs, preview environments, and production deployment.

## What You Get

| Capability | Local (`plattr dev`) | Production (EKS) |
|---|---|---|
| **Infrastructure** | Kind cluster with port-forwards | EKS with Ingress + TLS |
| **PostgreSQL** | Pod on :5432 | Aurora (provisioned per-app schema) |
| **Object storage** | MinIO on :9000 | S3 buckets |
| **Auth (Keycloak)** | Dev instance on :8080 | Managed Keycloak on EKS |
| **REST API (PostgREST)** | Auto-generated on :3001 | Sidecar in app pod, routed via `/api/rest` |
| **Local deploy** | `plattr deploy local` (test, build, scan, deploy) | CI/CD via GitHub Actions |
| **Preview environments** | `plattr preview start --pr 42` | Auto-created from PRs, TTL-based cleanup |

## Architecture

```
                          +-------------------+
                          |   GitHub Actions   |
                          |  (build & push)    |
                          +--------+----------+
                                   |
                                   v
+----------+         +-------------------------+         +-----------+
|          |  apply  |     Plattr Operator      |  create |           |
| kubectl  +-------->+  (watches Application &  +-------->+ Aurora PG |
|  / CLI   |         |   PreviewEnvironment)    |         | S3        |
+----------+         +--------+--------+-------+         | Keycloak  |
                              |        |                  +-----------+
                              v        v
                     +--------+--+  +--+--------+
                     | Deployment |  |  Ingress  |
                     | (app +     |  | (TLS +    |
                     |  postgrest)|  |  routing) |
                     +------------+  +-----------+
```

**Operator** — Kubernetes controller that reconciles `Application` and `PreviewEnvironment` CRDs into real infrastructure (database schemas, S3 buckets, Keycloak realms, Deployments, Services, Ingresses).

**Dagger** — Build and CI pipeline. Builds production container images and runs ephemeral tests.

**CLI** — Developer-facing tool (`plattr init`, `plattr dev`, `plattr deploy local`, `plattr test`, etc.).

**CDK** — AWS infrastructure stacks (EKS cluster config, IRSA roles, CI/CD pipelines, add-ons).

## Monorepo Structure

```
packages/
  operator/     Kubernetes operator (TypeScript, @kubernetes/client-node)
  dagger/       Build & CI pipeline (Dagger module)
  cli/          Developer CLI (Commander.js)
  cdk/          AWS CDK stacks
  shared/       Shared types, SQL generators, config parser
examples/
  nextjs-app/   Sample Next.js app with plattr.yaml
manifests/
  crds/         Application & PreviewEnvironment CRD definitions
  examples/     Sample Application & PreviewEnvironment resources
docs/           Documentation
```

## Quick Start

### For Developers

```bash
# Install the CLI
npm install -g @plattr/cli

# Initialize a new app
plattr init

# Start local infrastructure (Kind cluster, database, storage, auth)
plattr dev

# Source env vars and start your dev server
source .plattr/my-app.env
npx next dev

# Run tests
plattr test

# Build, scan, and deploy to local cluster
plattr deploy local

# Check status of a deployed app
plattr status
```

See the full [Developer Guide](docs/developer-guide.md).

### For Platform Teams

```bash
# Deploy infrastructure
cd packages/cdk
npx cdk deploy PlattrOperatorStack PlattrCicdStack

# Install CRDs
kubectl apply -f manifests/crds/

# Verify operator is running
kubectl get pods -n plattr-system
```

See the full [Plattr Team Guide](docs/plattr-team-guide.md).

## Documentation

- [Developer Guide](docs/developer-guide.md) — Building apps, local dev, deploying, databases, storage, auth
- [Plattr Team Guide](docs/plattr-team-guide.md) — Infrastructure, operator deployment, monitoring, troubleshooting
- Reference
  - [`plattr.yaml` Reference](docs/reference/plattr-yaml.md)
  - [CLI Reference](docs/reference/cli.md)
  - [Architecture Deep-Dive](docs/reference/architecture.md)
  - [CRD Reference](docs/reference/crds.md)

## Example `plattr.yaml`

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
