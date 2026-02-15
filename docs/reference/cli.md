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

Start the local development environment with all configured services.

```bash
plattr dev [options]
```

| Option | Description | Default |
|---|---|---|
| `-p, --port <port>` | Port for the app dev server | `3000` (or `local.port` from config) |

**Services started** (conditional on `plattr.yaml`):

| Service | Port | Condition |
|---|---|---|
| App (hot-reload) | `--port` value | Always |
| PostgreSQL | 5432 | `database.enabled: true` |
| PostgREST | 3001 | `database.enabled: true` |
| MinIO | 9000, 9001 | `storage.enabled: true` |
| Keycloak | 8080 | `auth.enabled: true` |

**Example:**
```bash
plattr dev
plattr dev --port 4000
```

---

### `plattr down`

Stop the local development environment.

```bash
plattr down
```

Sends SIGTERM to the running Dagger process. Checks `~/.plattr/dev.pid` first, falls back to finding orphaned `dagger call dev` processes.

---

### `plattr build`

Build a production container image.

```bash
plattr build
```

Runs `dagger call build --source=.` to produce an optimized production image based on the detected framework.

---

### `plattr test`

Run tests with full infrastructure (database, storage if configured).

```bash
plattr test
```

Runs `dagger call test --source=.`. Starts real PostgreSQL and MinIO instances for integration testing.

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

Runs `dagger call db-shell --source=. terminal`.

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
  ✅ DatabaseReady
  ✅ StorageReady
  ✅ AuthReady
  ✅ DeploymentReady
  ✅ IngressReady
```

Status icons: ✅ (True), ❌ (False), ⏳ (Unknown)

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
