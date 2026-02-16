# CLAUDE.md

## Project Overview

This is an internal developer platform (IDP) called Plattr that provides a Vercel-like experience on Kubernetes. Developers define their app in a `plattr.yaml` and get databases, storage, auth, Redis, OpenSearch, auto-generated REST APIs, preview environments, and production deployment.

All 13 stages of development are complete.

## Documentation

- [Developer Guide](docs/developer-guide.md) — Building apps, local dev, deploying
- [Plattr Team Guide](docs/plattr-team-guide.md) — Infrastructure, operations, troubleshooting
- [plattr.yaml Reference](docs/reference/plattr-yaml.md)
- [CLI Reference](docs/reference/cli.md)
- [Architecture Deep-Dive](docs/reference/architecture.md)
- [CRD Reference](docs/reference/crds.md)

## Monorepo Structure

```
packages/
  operator/     K8s operator — reconciles Application/PreviewEnvironment CRDs
  dagger/       Build & CI pipeline — production images, ephemeral tests
  cli/          Developer CLI — plattr dev/deploy/test/infra/db/env commands
  cdk/          AWS CDK stacks — EKS operator stack, CI/CD stack
  shared/       Shared types, SQL generators, config parser
examples/
  nextjs-app/   Sample Next.js app with plattr.yaml
manifests/
  crds/         Application & PreviewEnvironment CRD definitions
  examples/     Sample K8s resources
```

## Key Technical Details

- **K8s client**: `@kubernetes/client-node` v0.22.3 — uses positional parameters
- **CRDs**: `Application` and `PreviewEnvironment` in `platform.internal/v1alpha1`
- **Reconcilers**: database.ts, storage.ts, auth.ts, workload.ts, preview.ts, status.ts
- **PostgREST**: Runs as a sidecar container (v12.2.3) when `database.enabled`
- **Environment prefixing**: `prod_`, `staging_`, `uat_` for DB schemas/roles; preview uses PR-suffixed names
- **Build system**: Turbo monorepo with npm workspaces

## Local Development (CLI)

```bash
# Start local infrastructure (Kind cluster, DB, storage, auth, Redis, OpenSearch)
plattr dev

# Source env vars and start your dev server
source .plattr/{appName}.env
npx next dev

# Run tests (auto-detects vitest/jest/rspec/minitest)
plattr test

# Build, scan, and deploy to local Kind cluster
plattr deploy local

# Manage infrastructure: status, stop, start, destroy
plattr infra status
```

## Running the Operator Locally

```bash
cd packages/operator
DB_ADMIN_URL=postgresql://... BASE_DOMAIN=localhost KEYCLOAK_URL=http://localhost:8080 npx tsx src/index.ts

# Apply a sample app
kubectl apply -f manifests/examples/sample-app.yaml
```

## Common Gotchas

- Clear tsx cache between code changes: `rm -rf /tmp/tsx-*`
- Kill old operator processes: `pkill -f "tsx src/index"`
- PG roles can't have hyphens — sanitized with `.replace(/-/g, '_')`
- Generation-based tracking prevents infinite reconciliation loops from status updates
