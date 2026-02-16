# Plattr

> **Alpha software** — This project is under active development and not yet production-ready. APIs, configuration formats, and behavior may change without notice.

An internal developer platform that gives teams a Vercel-like experience on top of Kubernetes. Define your app in a `plattr.yaml`, run `plattr dev` locally, push to deploy.

Plattr handles databases, object storage, authentication, Redis, OpenSearch, auto-generated REST APIs, preview environments, and production deployment.

## What You Get

| Capability | Local (`plattr dev`) | Production (EKS) |
|---|---|---|
| **Infrastructure** | Kind cluster with port-forwards | EKS with Ingress + TLS |
| **PostgreSQL** | Pod on :5432 | Aurora (provisioned per-app schema) |
| **Object storage** | MinIO on :9000 | S3 buckets |
| **Auth (Keycloak)** | Dev instance on :8080 | Managed Keycloak on EKS |
| **Redis** | Pod on :6379 | Managed Redis |
| **OpenSearch** | Pod on :9200, Dashboards on :5601 | Managed OpenSearch |
| **REST API (PostgREST)** | Auto-generated on :3001 | Sidecar in app pod, routed via `/api/rest` |
| **Local deploy** | `plattr deploy local` (test, build, scan, deploy) | CI/CD via GitHub Actions |
| **Preview environments** | `plattr preview start --pr 42` | Auto-created from PRs, TTL-based cleanup |

## Quick Start

```bash
# Start local infrastructure
plattr dev

# Source env vars and start your dev server
source .plattr/{appName}.env
npx next dev

# Build, scan, and deploy to local Kind cluster
plattr deploy local
```

## Documentation

- [Developer Guide](developer-guide.md) — Building apps, local dev, deploying
- [Plattr Team Guide](plattr-team-guide.md) — Infrastructure, operations, troubleshooting
- **Reference**
    - [Architecture](reference/architecture.md)
    - [CLI](reference/cli.md)
    - [CRDs](reference/crds.md)
    - [plattr.yaml](reference/plattr-yaml.md)
