# `plattr.yaml` Reference

The `plattr.yaml` file defines your application's configuration. It lives in the root of your project and is read by the CLI (`plattr dev`, `plattr init`) and the Dagger pipeline.

## Full Example

```yaml
name: my-app
framework: nextjs

database:
  enabled: true
  schemaName: my_app
  migrations:
    path: ./prisma/migrations
    engine: prisma

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

redis:
  enabled: true

search:
  enabled: true

scaling:
  min: 2
  max: 20
  targetCPU: 70

local:
  port: 3000
  env:
    DEBUG: "true"
    LOG_LEVEL: verbose
```

## Field Reference

### Top-Level Fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | Yes | — | App name. Lowercase alphanumeric and hyphens only. Must match `/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/`. |
| `framework` | string | No | Auto-detected | One of: `nextjs`, `rails`, `static`, `docker`. Auto-detected from project files if not specified. |

### `database`

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `database.enabled` | boolean | Yes | — | Enable PostgreSQL database provisioning. |
| `database.schemaName` | string | No | `name` with hyphens replaced by underscores | PostgreSQL schema name. Automatically environment-prefixed in production (e.g., `prod_my_app`). |
| `database.migrations.path` | string | No | `./migrations` | Path to migration files, relative to project root. |
| `database.migrations.engine` | string | No | — | Migration engine: `prisma`, `knex`, or `raw`. |

### `storage`

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `storage.enabled` | boolean | Yes | — | Enable S3-compatible object storage. |
| `storage.buckets` | array | No | `[]` | List of bucket definitions. |
| `storage.buckets[].name` | string | Yes | — | Bucket name. Alphanumeric and hyphens. |
| `storage.buckets[].public` | boolean | No | `false` | If `true`, objects are publicly readable. |

### `auth`

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `auth.enabled` | boolean | Yes | — | Enable Keycloak authentication. |
| `auth.providers` | string[] | No | `[]` | Identity providers to configure: `google`, `github`, `saml`, `oidc`. |

### `redis`

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `redis.enabled` | boolean | Yes | — | Enable Redis cache. Locally runs Redis 7 in the Kind cluster. |

### `search`

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `search.enabled` | boolean | Yes | — | Enable OpenSearch. Locally runs OpenSearch 2.18 with Dashboards in the Kind cluster. |

### `scaling`

Controls the Horizontal Pod Autoscaler in production.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `scaling.min` | number | No | `2` | Minimum replica count. |
| `scaling.max` | number | No | `20` | Maximum replica count. |
| `scaling.targetCPU` | number | No | `70` | Target CPU utilization percentage for scaling. |

### `local`

Configuration for local development only. Has no effect in production.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `local.port` | number | No | `3000` | Port for the local dev server. |
| `local.env` | object | No | `{}` | Additional environment variables injected during `plattr dev`. Keys are variable names, values are strings. |

## Minimal Examples

### Static Site (No Services)

```yaml
name: my-landing-page
framework: static
```

### API with Database Only

```yaml
name: my-api
framework: docker

database:
  enabled: true
```

### Full-Stack App

```yaml
name: my-saas
framework: nextjs

database:
  enabled: true
  migrations:
    engine: prisma

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

redis:
  enabled: true

search:
  enabled: true
```

## Notes

- The `name` field is used to derive Kubernetes resource names, database schemas, S3 bucket prefixes, and DNS names. Choose it carefully — changing it later requires migration.
- `framework` affects the build process (Dockerfile generation) and local dev server command. Use `docker` if your project has its own Dockerfile.
- `scaling` is only used in production. Local dev always runs a single instance. Preview environments use `min: 1, max: 2`.
- `database.schemaName` is rarely needed. The default (`name` with hyphens as underscores) works for most apps. Use this only if you need a specific schema name.
