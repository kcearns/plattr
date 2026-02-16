# CLI Reference

The `plattr` CLI is the developer interface to the platform. Install it with `npm install -g @plattr/cli`.

## Commands

### `plattr init`

Initialize a new app for the platform.

```bash
plattr init
```

Interactive prompts:
1. App name (lowercase alphanumeric with hyphens)
2. Framework (auto-detected: `nextjs`, `rails`, `static`, `docker`)
3. Enable database?
4. Enable storage?
5. Enable authentication?

**Creates:**
- `plattr.yaml` — app configuration
- `.github/workflows/plattr-deploy.yml` — CI/CD pipeline

---

### `plattr dev`

Set up local infrastructure and prepare the environment for development.

```bash
plattr dev [options]
```

| Option | Description | Default |
|---|---|---|
| `-p, --port <port>` | Port hint (reserved for future use) | `3000` (or `local.port` from config) |

**What it does:**

1. Creates a local Kind cluster (if not already running)
2. Starts a local container registry on port 5050
3. Applies Kubernetes manifests for enabled services (PostgreSQL, PostgREST, MinIO, Keycloak)
4. Waits for all services to be ready
5. Sets up database schema and roles
6. Creates storage buckets
7. Starts detached `kubectl port-forward` processes
8. Writes environment variables to `.plattr/{appName}.env`
9. Prints export commands and service URLs

**Important:** `plattr dev` does **not** start your application's dev server. After it completes, source the env file and start your dev server manually:

```bash
plattr dev
source .plattr/my-app.env
npx next dev          # Next.js
bin/rails server      # Rails
```

**Services started** (conditional on `plattr.yaml`):

| Service | Port | Condition |
|---|---|---|
| PostgreSQL | 5432 | Always |
| PostgREST | 3001 | `database.enabled: true` |
| MinIO | 9000, 9001 | `storage.enabled: true` |
| Keycloak | 8080 | `auth.enabled: true` |

**State files** (in `.plattr/` directory):
- `{appName}.env` — environment variables (sourceable)
- `{appName}.pids` — port-forward process IDs

---

### `plattr test`

Run tests against local infrastructure.

```bash
plattr test [options]
```

| Option | Description | Default |
|---|---|---|
| `--ci` | Run Dagger-based ephemeral tests (clean state) | `false` |

**Without `--ci`** (default): Auto-detects the test runner and runs tests locally using the environment from `.plattr/{appName}.env`. Checks that infrastructure is running before starting.

Supported test runners (auto-detected):
- **Vitest** — detects `vitest.config.{ts,js,mts}`
- **Jest** — detects `jest.config.{ts,js,mjs}`
- **npm test** — uses `package.json` test script (if it exists and isn't the default)
- **RSpec** — detects `spec/**/*.rb` (Rails)
- **Minitest** — detects `test/**/*.rb` (Rails)

**With `--ci`**: Runs `dagger call test --source=.` for fully ephemeral tests with clean database state.

**Example:**
```bash
# Run local tests (requires plattr dev running)
plattr test

# Run ephemeral tests via Dagger
plattr test --ci
```

---

### `plattr build`

Build a production container image.

```bash
plattr build
```

Runs `dagger call build --source=.` to produce an optimized production image based on the detected framework.

---

### `plattr deploy local`

Build, test, scan, and deploy the app to the local Kind cluster.

```bash
plattr deploy local [options]
```

| Option | Description | Default |
|---|---|---|
| `-p, --port <port>` | Port for the deployed app | `3000` (or `local.port` from config) |
| `--skip-tests` | Skip the test step | `false` |
| `--skip-scan` | Skip the Trivy security scan | `false` |
| `--fail-on-scan` | Exit with error if vulnerabilities found (no prompt) | `false` |

**Pipeline steps:**

1. **Tests** — Auto-detects and runs tests (skippable with `--skip-tests`)
2. **Build** — Builds production image via Dagger
3. **Push** — Pushes image to local registry (`localhost:5050`)
4. **Security Scan** — Runs Trivy scan for HIGH/CRITICAL vulnerabilities (skippable with `--skip-scan`)
5. **Deploy** — Applies Kubernetes manifests (ConfigMap, Deployment, Service) and waits for rollout
6. **Port-forward** — Starts a detached port-forward to the deployed app

**Example:**
```bash
# Full pipeline
plattr deploy local

# Quick deploy (skip tests and scan)
plattr deploy local --skip-tests --skip-scan

# CI-style (fail on vulnerabilities)
plattr deploy local --fail-on-scan
```

---

### `plattr undeploy local`

Remove the app deployment from the local Kind cluster.

```bash
plattr undeploy local
```

Kills tracked port-forward processes and deletes the Deployment, Service, and ConfigMap from the cluster. Does **not** remove the infrastructure (PostgreSQL, MinIO, etc.) — use `plattr infra destroy` for that.

---

### `plattr infra status`

Show local infrastructure status.

```bash
plattr infra status
```

Displays all pods in the `plattr-local` namespace.

---

### `plattr infra stop`

Stop local infrastructure (data preserved).

```bash
plattr infra stop
```

Kills port-forward processes and scales all deployments to zero replicas. Data in persistent volumes is preserved. Run `plattr dev` to restart.

---

### `plattr infra start`

Start local infrastructure.

```bash
plattr infra start
```

Scales all deployments back to one replica. Use this after `plattr infra stop` to resume without a full `plattr dev` cycle.

---

### `plattr infra destroy`

Delete local cluster and all data.

```bash
plattr infra destroy
```

Kills port-forward processes, clears all state files (`.plattr/`), deletes the Kind cluster, and removes the local container registry. All data is lost. Run `plattr dev` to recreate from scratch.

---

### `plattr preview start`

Start a local preview environment for a pull request.

```bash
plattr preview start --pr <number> [options]
```

| Option | Description | Default |
|---|---|---|
| `--pr <number>` | Pull request number (required) | — |
| `-p, --port <port>` | Port for the preview app | `3100` |

Creates an isolated environment with PR-specific database schema and storage.

**Example:**
```bash
plattr preview start --pr 42
plattr preview start --pr 42 --port 3200
```

---

### `plattr preview list`

List active remote preview environments.

```bash
plattr preview list
```

**Output:**
```
PR   App          Phase     URL                                          Expires
42   my-app       Running   https://pr-42.my-app.preview.company.dev     2024-01-15T12:00:00Z
```

Queries `PreviewEnvironment` CRDs via kubectl.

---

### `plattr db migrate`

Run database migrations.

```bash
plattr db migrate [options]
```

| Option | Description | Default |
|---|---|---|
| `--engine <engine>` | Migration engine: `prisma`, `knex`, `raw` | Auto-detect |

**Engines:**
- `prisma` — runs `npx prisma migrate deploy`
- `knex` — runs `npx knex migrate:latest`
- `raw` — executes `.sql` files from the migrations directory

**Example:**
```bash
plattr db migrate
plattr db migrate --engine prisma
```

---

### `plattr db seed`

Seed the database with test data.

```bash
plattr db seed [options]
```

| Option | Description | Default |
|---|---|---|
| `--file <path>` | Path to seed file | `seed.sql` |

**Example:**
```bash
plattr db seed
plattr db seed --file seeds/test-data.sql
```

---

### `plattr db shell`

Open an interactive `psql` shell connected to the local database.

```bash
plattr db shell
```

---

### `plattr db connect`

Connect to a remote database via `psql`.

```bash
plattr db connect [options]
```

| Option | Description | Default |
|---|---|---|
| `--env <environment>` | Target environment | `production` |

Retrieves the `DATABASE_URL` from the Kubernetes Secret (`{appName}-db`) and opens an interactive `psql` session.

**Example:**
```bash
plattr db connect
plattr db connect --env staging
```

---

### `plattr db reset`

Reset the local database (deletes all data).

```bash
plattr db reset
```

Deletes the persistent volume claim and restarts the PostgreSQL deployment. Run `plattr dev` to recreate schemas.

---

### `plattr status`

Show application status and conditions.

```bash
plattr status [options]
```

| Option | Description | Default |
|---|---|---|
| `--env <environment>` | Target environment | `production` |
| `--pr <number>` | PR number (for preview envs) | — |

**Output:**
```
Application: my-app
Environment: production
Phase:       Running
URL:         https://my-app.platform.company.dev

Conditions:
  DatabaseReady
  StorageReady
  AuthReady
  DeploymentReady
  IngressReady
```

**Example:**
```bash
plattr status
plattr status --env staging
plattr status --pr 42
```

---

### `plattr logs`

Stream application logs.

```bash
plattr logs [options]
```

| Option | Description | Default |
|---|---|---|
| `--env <environment>` | Target environment | `production` |
| `-f, --follow` | Stream logs continuously | `false` |
| `--tail <lines>` | Number of recent lines to show | All |
| `--pr <number>` | PR number (for preview envs) | — |

Runs `kubectl logs` with `--all-containers` to include both app and PostgREST sidecar logs.

**Example:**
```bash
plattr logs
plattr logs -f
plattr logs --tail 100 --env staging
plattr logs --pr 42 -f
```

---

### `plattr env set`

Set one or more environment variables.

```bash
plattr env set <KEY=VALUE...> [options]
```

| Option | Description | Default |
|---|---|---|
| `--env <environment>` | Target environment | `production` |

Creates or updates a ConfigMap (`{appName}-env`) and restarts the Deployment to apply changes.

**Example:**
```bash
plattr env set API_KEY=abc123
plattr env set API_KEY=abc123 FEATURE_FLAG=true
plattr env set --env staging DEBUG=true
```

---

### `plattr env list`

List all environment variables (Plattr-managed and user-defined).

```bash
plattr env list [options]
```

| Option | Description | Default |
|---|---|---|
| `--env <environment>` | Target environment | `production` |

**Example:**
```bash
plattr env list
plattr env list --env staging
```

---

### `plattr env unset`

Remove an environment variable.

```bash
plattr env unset <KEY> [options]
```

| Option | Description | Default |
|---|---|---|
| `--env <environment>` | Target environment | `production` |

Removes the key from the ConfigMap and restarts the Deployment.

**Example:**
```bash
plattr env unset API_KEY
plattr env unset --env staging DEBUG
```

---

## Environment Resolution

Commands that accept `--env` map environment names to Kubernetes namespaces:

| `--env` value | Namespace | Resource Name |
|---|---|---|
| `production` | `production` | `{appName}` |
| `staging` | `staging` | `{appName}` |
| `uat` | `uat` | `{appName}` |
| `preview` (with `--pr`) | `preview-{appName}-pr-{N}` | `{appName}-pr{N}` |

The app name is read from `plattr.yaml` in the current directory.
