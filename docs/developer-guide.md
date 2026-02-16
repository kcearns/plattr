# Developer Guide

This guide walks you through building, running, and deploying apps on Plattr. By the end, you'll have a full-stack app with a database, object storage, authentication, and an auto-generated REST API — all from a single `plattr.yaml` file.

## Prerequisites

- **Node.js** 18+ and npm
- **Docker** (Docker Desktop or colima)
- **Kind** — `go install sigs.k8s.io/kind@latest` or `brew install kind`
- **kubectl** — `brew install kubectl` or [install guide](https://kubernetes.io/docs/tasks/tools/)
- **Dagger CLI** — `curl -fsSL https://dl.dagger.io/dagger/install.sh | sh`
- **Plattr CLI** — `npm install -g @plattr/cli`

## Creating a New App

```bash
mkdir my-app && cd my-app
plattr init
```

The interactive wizard asks:
1. **App name** — lowercase, alphanumeric, hyphens allowed (e.g., `my-app`)
2. **Framework** — auto-detected, or choose: `nextjs`, `rails`, `static`, `docker`
3. **Database** — enable PostgreSQL?
4. **Storage** — enable S3-compatible object storage?
5. **Auth** — enable Keycloak authentication?

This creates two files:
- `plattr.yaml` — your app configuration
- `.github/workflows/plattr-deploy.yml` — CI/CD pipeline

### Example `plattr.yaml`

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
    - name: assets
      public: true

auth:
  enabled: true
  providers:
    - google
    - github

local:
  port: 3000
```

See the full [plattr.yaml Reference](reference/plattr-yaml.md) for all options.

## Local Development

```bash
plattr dev
```

This sets up your entire infrastructure stack locally on a Kind (Kubernetes in Docker) cluster:

1. Creates a Kind cluster and local container registry (first run only)
2. Deploys infrastructure services as Kubernetes pods
3. Starts port-forwards so services are accessible on localhost
4. Writes environment variables to `.plattr/{appName}.env`

**After `plattr dev` completes**, source the env file and start your dev server:

```bash
source .plattr/my-app.env
npx next dev          # Next.js
bin/rails server      # Rails
npm run dev           # Generic
```

### Local Services

| Service | Port | Condition |
|---|---|---|
| PostgreSQL | 5432 | Always |
| PostgREST | 3001 | `database.enabled: true` |
| MinIO | 9000, 9001 | `storage.enabled: true` |
| Keycloak | 8080 | `auth.enabled: true` |

All services start only if enabled in `plattr.yaml`. A static site with no database won't start PostgreSQL.

### Managing Infrastructure

```bash
# Check infrastructure status
plattr infra status

# Stop infrastructure (data preserved, saves resources)
plattr infra stop

# Restart stopped infrastructure
plattr infra start

# Delete everything (cluster, registry, all data)
plattr infra destroy
```

### Custom Port

```bash
plattr dev --port 4000
```

### State Files

`plattr dev` creates a `.plattr/` directory in your project with:
- `{appName}.env` — environment variables you can `source`
- `{appName}.pids` — port-forward process IDs (managed automatically)

Add `.plattr/` to your `.gitignore`.

## Environment Variables

Plattr automatically provides these env vars in `.plattr/{appName}.env`:

### Database (when `database.enabled: true`)

| Variable | Local Value | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://plattr:localdev@127.0.0.1:5432/plattr?search_path=my_app` | Full connection string |
| `POSTGREST_URL` | `http://127.0.0.1:3001` | PostgREST endpoint |

### Storage (when `storage.enabled: true`)

| Variable | Local Value | Description |
|---|---|---|
| `S3_ENDPOINT` | `http://127.0.0.1:9000` | S3 endpoint |
| `S3_ACCESS_KEY` | `minioadmin` | Access key |
| `S3_SECRET_KEY` | `minioadmin` | Secret key |
| `S3_REGION` | `us-east-1` | Region |
| `S3_BUCKET_UPLOADS` | `my-app-uploads` | Bucket name (one per bucket in config) |

Bucket env var names are derived from the bucket name: `uploads` becomes `S3_BUCKET_UPLOADS`, `user-files` becomes `S3_BUCKET_USER_FILES`.

### Auth (when `auth.enabled: true`)

| Variable | Local Value | Description |
|---|---|---|
| `AUTH_ISSUER_URL` | `http://127.0.0.1:8080/realms/my-app` | OIDC issuer URL |
| `AUTH_CLIENT_ID` | `my-app-app` | OIDC client ID |

### Production Equivalents

| Variable | Local Value | Production Value |
|---|---|---|
| `DATABASE_URL` | `postgresql://plattr:localdev@127.0.0.1:5432/...` | `postgresql://{app}_app:{random}@aurora:5432/...` |
| `POSTGREST_URL` | `http://127.0.0.1:3001` | `https://{domain}/api/rest` |
| `POSTGREST_INTERNAL_URL` | *(not set)* | `http://localhost:3001` |
| `S3_ENDPOINT` | `http://127.0.0.1:9000` | *(AWS S3 default)* |
| `AUTH_ISSUER_URL` | `http://127.0.0.1:8080/realms/{app}` | `https://auth.{baseDomain}/realms/{app}` |

In production, `POSTGREST_INTERNAL_URL` connects directly to the PostgREST sidecar (same pod, no network hop). Use it for server-side calls. Use `POSTGREST_URL` for client-side/browser calls.

## Testing

### Local Tests

```bash
plattr test
```

Auto-detects your test runner and runs tests using the environment from `.plattr/{appName}.env`. Requires infrastructure to be running (`plattr dev` first).

Supported test runners (auto-detected):
- **Vitest** — `vitest.config.{ts,js,mts}`
- **Jest** — `jest.config.{ts,js,mjs}`
- **npm test** — `package.json` test script
- **RSpec** — `spec/**/*.rb`
- **Minitest** — `test/**/*.rb`

### Ephemeral CI Tests

```bash
plattr test --ci
```

Runs Dagger-based tests with clean infrastructure (fresh database, fresh state). Use this in CI pipelines or when you want guaranteed clean state.

## Database Workflows

### Running Migrations

```bash
# Auto-detect migration engine
plattr db migrate

# Specify engine explicitly
plattr db migrate --engine prisma
plattr db migrate --engine knex
plattr db migrate --engine raw
```

Supported engines:
- **prisma** — runs `npx prisma migrate deploy`
- **knex** — runs `npx knex migrate:latest`
- **raw** — executes `.sql` files from the migrations directory

### Seeding Data

```bash
# Default seed file
plattr db seed

# Custom seed file
plattr db seed --file seeds/test-data.sql
```

### Interactive Shell (Local)

```bash
plattr db shell
```

Opens a `psql` session connected to your local database.

### Connect to Remote Database

```bash
# Connect to production
plattr db connect

# Connect to staging
plattr db connect --env staging
```

Retrieves the `DATABASE_URL` from the Kubernetes Secret and opens a `psql` session.

### Reset Local Database

```bash
plattr db reset
```

Deletes the persistent volume and restarts PostgreSQL. Run `plattr dev` to recreate schemas.

### Schema and Roles

Plattr creates these PostgreSQL objects for your app:

- **Schema**: `{env}_{app_name}` (e.g., `prod_my_app`, `staging_my_app`)
- **App role**: `{env}_{app_name}_app` — full CRUD access, used by your app
- **Anon role**: `{env}_{app_name}_anon` — no permissions by default, used by PostgREST

To expose a table through PostgREST, grant permissions to the anon role in your migrations:

```sql
GRANT SELECT ON my_table TO my_app_anon;
GRANT INSERT, UPDATE ON my_table TO my_app_anon;
```

## PostgREST (Auto-Generated REST API)

When `database.enabled: true`, you get an auto-generated REST API from your database schema. PostgREST introspects your tables and exposes them as RESTful endpoints.

### Local Usage

```bash
# List all rows in the "todos" table
curl http://localhost:3001/todos

# Filter
curl "http://localhost:3001/todos?completed=eq.false"

# Insert
curl -X POST http://localhost:3001/todos \
  -H "Content-Type: application/json" \
  -d '{"title": "Buy milk", "completed": false}'

# Update
curl -X PATCH "http://localhost:3001/todos?id=eq.1" \
  -H "Content-Type: application/json" \
  -d '{"completed": true}'

# Delete
curl -X DELETE "http://localhost:3001/todos?id=eq.1"
```

### Production Usage

In production, PostgREST runs as a sidecar in your app pod. Requests go through the Ingress:

```
https://my-app.platform.company.dev/api/rest/todos
```

The `/api/rest` prefix is stripped by nginx before reaching PostgREST. From your app's server-side code, use the internal URL for faster access:

```javascript
// Server-side (same pod, no network hop)
const res = await fetch(`${process.env.POSTGREST_INTERNAL_URL}/todos`);

// Client-side (browser, goes through Ingress)
const res = await fetch(`${process.env.POSTGREST_URL}/todos`);
```

### Controlling Access

By default, PostgREST uses the `_anon` role which has no table permissions. You control what's exposed in your migrations:

```sql
-- Expose read-only access
GRANT SELECT ON todos TO my_app_anon;

-- Expose full CRUD
GRANT ALL ON todos TO my_app_anon;

-- No grant = not accessible through PostgREST
```

Row-level security (RLS) policies are respected automatically.

### Schema Reload

When you run a migration that adds or changes tables, PostgREST automatically detects the change (via PostgreSQL LISTEN/NOTIFY). You can also trigger a manual reload:

```sql
NOTIFY pgrst, 'reload schema';
```

## Object Storage

### Using S3-Compatible Storage

Buckets defined in `plattr.yaml` are created automatically. Use any S3 SDK:

```javascript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
  forcePathStyle: true, // Required for MinIO (local)
});

await s3.send(new PutObjectCommand({
  Bucket: process.env.S3_BUCKET_UPLOADS,
  Key: 'photo.jpg',
  Body: fileBuffer,
}));
```

### Local MinIO Console

Open `http://localhost:9001` in your browser. Login with `minioadmin` / `minioadmin`.

### Public vs Private Buckets

```yaml
storage:
  enabled: true
  buckets:
    - name: uploads    # Private — requires signed URLs
      public: false
    - name: assets     # Public — accessible via direct URL
      public: true
```

## Authentication

### Local Development

Keycloak runs at `http://localhost:8080` with a pre-configured realm matching your app name. A test user and OIDC client are provisioned automatically.

Admin console: `http://localhost:8080/admin` (credentials: `admin` / `admin`)

### OIDC Integration

Use the standard OIDC flow with the provided env vars:

```javascript
// Example: NextAuth.js configuration
import KeycloakProvider from 'next-auth/providers/keycloak';

export const authOptions = {
  providers: [
    KeycloakProvider({
      clientId: process.env.AUTH_CLIENT_ID,
      issuer: process.env.AUTH_ISSUER_URL,
    }),
  ],
};
```

### Identity Providers

Providers listed in `plattr.yaml` (google, github, saml, oidc) are noted for configuration but require Plattr-level OAuth credentials set up by your platform team.

## Local Deploy Pipeline

Test your production container locally before pushing to CI:

```bash
plattr deploy local
```

This runs a full pipeline:
1. **Tests** — auto-detected test runner
2. **Build** — production container image via Dagger
3. **Push** — to the local registry (`localhost:5050`)
4. **Security scan** — Trivy scans for HIGH/CRITICAL vulnerabilities
5. **Deploy** — to the Kind cluster with port-forwarding

```bash
# Skip tests and scan for quick iteration
plattr deploy local --skip-tests --skip-scan

# Fail on vulnerabilities (CI-style)
plattr deploy local --fail-on-scan

# Remove the deployment
plattr undeploy local
```

## Deploying to Production

### CI/CD Pipeline

`plattr init` generates `.github/workflows/plattr-deploy.yml` which:

1. Builds a production container image
2. Pushes to ECR
3. Updates the `Application` CRD with the new `imageRef`
4. The operator reconciles the change (rolling update)

### Manual Build and Deploy

```bash
# Build production image
plattr build

# Run tests with full infrastructure
plattr test --ci
```

### Environments

Plattr supports four environments:

| Environment | Namespace | Domain Pattern |
|---|---|---|
| `production` | `production` | `{app}.{baseDomain}` |
| `staging` | `staging` | `{app}.staging.{baseDomain}` |
| `uat` | `uat` | `{app}.uat.{baseDomain}` |
| `preview` | `preview-{app}-pr-{N}` | `pr-{N}.{app}.preview.{baseDomain}` |

Each environment gets its own database schema, storage buckets, and Keycloak realm — fully isolated.

## Preview Environments

Every pull request can get an isolated preview environment with its own database, storage, and URL.

### Local Preview

```bash
plattr preview start --pr 42
plattr preview start --pr 42 --port 3100
```

### Remote Preview

Remote previews are created automatically when a `PreviewEnvironment` CRD is applied (typically from CI). List active previews:

```bash
plattr preview list
```

Output:

```
PR   App          Phase     URL                                          Expires
42   my-app       Running   https://pr-42.my-app.preview.company.dev     2024-01-15T12:00:00Z
87   my-app       Running   https://pr-87.my-app.preview.company.dev     2024-01-16T08:00:00Z
```

Preview environments have a TTL (default 72 hours) and are automatically cleaned up when they expire.

## Managing Environment Variables

### Set Variables

```bash
# Set one or more variables
plattr env set API_KEY=abc123
plattr env set API_KEY=abc123 FEATURE_FLAG=true

# Target a specific environment
plattr env set --env staging API_KEY=staging-key
```

### List Variables

```bash
plattr env list
plattr env list --env staging
```

Output shows both Plattr-managed and user-defined variables:

```
Plattr-managed:
  DATABASE_URL    = postgresql://...
  DB_HOST         = aurora-cluster.us-east-1.rds.amazonaws.com
  S3_ENDPOINT     = https://s3.us-east-1.amazonaws.com
  ...

User-defined:
  API_KEY         = abc123
  FEATURE_FLAG    = true
```

### Remove Variables

```bash
plattr env unset API_KEY
plattr env unset --env staging API_KEY
```

Setting or unsetting variables triggers a deployment restart to pick up the changes.

## Monitoring

### Application Status

```bash
plattr status
plattr status --env staging
plattr status --pr 42
```

Shows phase (Pending, Provisioning, Running, Failed) and condition status for each subsystem.

### Application Logs

```bash
# Recent logs
plattr logs

# Stream logs
plattr logs -f

# Last 100 lines
plattr logs --tail 100

# Staging environment
plattr logs --env staging

# Preview environment
plattr logs --pr 42
```

Logs include all containers in the pod (app + PostgREST sidecar if enabled).

## Example: Next.js App from Scratch

```bash
# 1. Create Next.js app
npx create-next-app@latest my-app
cd my-app

# 2. Initialize plattr config
plattr init
# Choose: nextjs, enable database, enable storage, enable auth

# 3. Start local infrastructure
plattr dev

# 4. Source env vars and start dev server
source .plattr/my-app.env
npx next dev
# App on :3000, DB on :5432, Storage on :9000, Auth on :8080, REST API on :3001

# 5. Create a migration (example with Prisma)
npx prisma init
# Edit prisma/schema.prisma, then:
npx prisma migrate dev --name init

# 6. Grant PostgREST access to your tables
# In a migration file:
# GRANT SELECT, INSERT, UPDATE, DELETE ON todos TO my_app_anon;

# 7. Test the REST API
curl http://localhost:3001/todos

# 8. Run tests
plattr test

# 9. Test production container locally
plattr deploy local

# 10. Push to deploy
git add . && git commit -m "Initial app"
git push origin main
# CI builds, pushes image, operator deploys

# 11. Check status
plattr status
```

## Example: Rails App from Scratch

```bash
# 1. Create Rails app
rails new my-rails-app --database=postgresql
cd my-rails-app

# 2. Initialize plattr config
plattr init
# Choose: rails, enable database

# 3. Update database.yml to use plattr env vars
# config/database.yml:
#   default: &default
#     adapter: postgresql
#     url: <%= ENV['DATABASE_URL'] %>

# 4. Start local infrastructure
plattr dev

# 5. Source env vars and start dev server
source .plattr/my-rails-app.env
bin/rails server

# 6. Run migrations
plattr db migrate --engine raw

# 7. Push to deploy
git add . && git commit -m "Initial app"
git push origin main
```
