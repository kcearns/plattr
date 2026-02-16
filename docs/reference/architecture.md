# Architecture Deep-Dive

This document covers the internal architecture of Plattr: how reconciliation works, how resources flow through the system, and how local and remote environments achieve parity.

## System Components

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   CLI        │     │   Dagger     │     │   CDK        │
│  (developer  │     │  (build &    │     │  (infra      │
│   commands)  │     │   CI tests)  │     │   stacks)    │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       │  kubectl/kind      │  build images      │  CloudFormation
       v                    v                    v
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Kubernetes  │     │  Docker      │     │  AWS         │
│  (Kind local │     │  (registry   │     │  (EKS, RDS,  │
│   or EKS)    │     │   :5050)     │     │   S3, etc.)  │
└──────┬───────┘     └──────────────┘     └──────────────┘
       │
       │  watch events
       v
┌──────────────────────────────────────────────────┐
│                 Plattr Operator                    │
│                                                    │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐    │
│  │  Database   │ │  Storage   │ │   Auth     │    │
│  │ Reconciler  │ │ Reconciler │ │ Reconciler │    │
│  └────────────┘ └────────────┘ └────────────┘    │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐    │
│  │  Workload   │ │  Preview   │ │   Status   │    │
│  │ Reconciler  │ │ Reconciler │ │ Reconciler │    │
│  └────────────┘ └────────────┘ └────────────┘    │
│  ┌────────────┐ ┌────────────┐                    │
│  │    TTL      │ │   Leader   │                    │
│  │ Controller  │ │  Election  │                    │
│  └────────────┘ └────────────┘                    │
└──────────────────────────────────────────────────┘
```

## Reconciliation Loop

The operator uses Kubernetes informers to watch for changes to `Application` and `PreviewEnvironment` CRDs.

### Event Flow

```
1. User applies Application CR
2. K8s API Server stores the resource
3. Informer fires 'add' or 'update' event
4. Operator checks metadata.generation vs last reconciled generation
5. If generation changed → run reconciliation
6. Reconciliation runs sequentially:
   a. reconcileDatabase()    → creates schema, roles, Secret
   b. reconcileStorage()     → creates S3 buckets, ConfigMap
   c. reconcileAuth()        → creates Keycloak realm, ConfigMap
   d. reconcileWorkload()    → creates Deployment, Service, Ingress, HPA
   e. reconcileStatus()      → updates status conditions and phase
7. Store reconciled generation to prevent re-processing
```

### Generation-Based Tracking

The operator tracks `metadata.generation` for each Application to avoid infinite reconciliation loops:

```
reconciledGenerations: Map<string, number>
```

- `metadata.generation` only increments when the **spec** changes (not status)
- Status updates via the status subresource do not trigger re-reconciliation
- If the generation matches what was last reconciled, the event is skipped
- On `delete` events, the generation is removed from the map after cleanup

### Retry Logic

Each reconciler uses exponential backoff with jitter:

| Attempt | Base Delay | With Jitter (50-150%) |
|---|---|---|
| 1 | 1s | 0.5s - 1.5s |
| 2 | 2s | 1s - 3s |
| 3 | 4s | 2s - 6s |

Maximum 3 retries per reconciliation. Maximum delay capped at 30 seconds.

### Upsert Pattern

All Kubernetes resource creation uses an idempotent upsert pattern:

```
1. Try create (POST)
2. If 409 Conflict → resource already exists → replace (PUT)
3. If other error → throw
```

This makes reconciliation safe to retry and handles cases where resources were partially created in a previous attempt.

## Resource Lifecycle

### Application Lifecycle

```
                    apply
  (nothing) ────────────────► Pending
                                │
                                │ reconcileDatabase()
                                │ reconcileStorage()
                                │ reconcileAuth()
                                v
                            Provisioning
                                │
                                │ reconcileWorkload()
                                │ pods become ready
                                v
                             Running ◄──── spec change triggers re-reconcile
                                │
                                │ kubectl delete
                                v
                            Terminating
                                │
                                │ cleanupWorkload()
                                │ cleanupAuth()
                                │ cleanupStorage()
                                │ cleanupDatabase()
                                v
                            (deleted)
```

### Resources Created per Application

| Reconciler | Resources | External Services |
|---|---|---|
| Database | Secret (`{name}-db`) | PostgreSQL schema, app role, anon role |
| Storage | ConfigMap (`{name}-storage`) | S3 buckets (with CORS and public policy if configured) |
| Auth | ConfigMap (`{name}-auth`) | Keycloak realm, OIDC client |
| Workload | ServiceAccount, Deployment, Service, Ingress, Ingress (API), HPA | — |

### Cleanup Order

Cleanup runs in reverse order to avoid dangling references:

1. Workload (Deployment, Service, Ingress, HPA)
2. Auth (Keycloak realm, ConfigMap)
3. Storage (S3 buckets, ConfigMap)
4. Database (PostgreSQL roles, schema, Secret)

Database cleanup is especially careful with role dependencies:
```sql
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA {schema} FROM {role};
ALTER DEFAULT PRIVILEGES IN SCHEMA {schema} REVOKE ALL ON TABLES FROM {role};
REASSIGN OWNED BY {role} TO postgres;
DROP OWNED BY {role};
DROP ROLE IF EXISTS {role};
```

## Environment Prefixing

All database schemas, roles, and S3 buckets are prefixed by environment to enable isolation within shared infrastructure.

### Database Prefixing

| Environment | Schema | App Role | Anon Role |
|---|---|---|---|
| production | `prod_my_app` | `prod_my_app_app` | `prod_my_app_anon` |
| staging | `staging_my_app` | `staging_my_app_app` | `staging_my_app_anon` |
| uat | `uat_my_app` | `uat_my_app_app` | `uat_my_app_anon` |
| preview (PR 42) | `my_app_pr42` | `my-app-pr42_app` | `my-app-pr42_anon` |

Preview environments don't add an extra prefix because the name already includes the PR number.

Hyphens are replaced with underscores in schema and role names because PostgreSQL identifiers cannot contain hyphens.

### Storage Prefixing

S3 bucket names: `plattr-{env}-{app}-{bucket}`

Examples:
- `plattr-prod-my-app-uploads`
- `plattr-staging-my-app-uploads`
- `plattr-preview-my-app-pr42-uploads`

## PostgREST Sidecar Pattern

When `database.enabled: true`, the operator adds PostgREST as a sidecar container in the app Deployment.

### Pod Layout

```
┌─────────────────────────────────┐
│              Pod                 │
│                                 │
│  ┌───────────┐  ┌───────────┐  │
│  │    App     │  │ PostgREST │  │
│  │  :3000     │  │  :3001    │  │
│  │            │  │           │  │
│  │ envFrom:   │  │ PGRST_*   │  │
│  │  db secret │  │ env vars  │  │
│  │  storage cm│  │           │  │
│  │  auth cm   │  │ DB_URI ←  │  │
│  │            │  │  from     │  │
│  │ POSTGREST_ │  │  secret   │  │
│  │ INTERNAL_  │  │           │  │
│  │ URL=       │  │ SCHEMAS=  │  │
│  │ localhost  │  │ prod_app  │  │
│  │ :3001      │  │           │  │
│  └───────────┘  └───────────┘  │
└─────────────────────────────────┘
```

### Why a Sidecar?

- **Shared lifecycle** — scales with the app, restarts with the app
- **Localhost access** — app can call PostgREST at `localhost:3001` with no network hop
- **No extra Service** — no separate Deployment or scaling concern
- **Resource efficient** — PostgREST is a lightweight Haskell binary (50m CPU, 64Mi memory)

### PostgREST Configuration

| Env Var | Value | Purpose |
|---|---|---|
| `PGRST_DB_URI` | From Secret `{name}-db`, key `DATABASE_URL` | Database connection |
| `PGRST_DB_SCHEMAS` | `{env}_{app_name}` | Which schema to expose |
| `PGRST_DB_ANON_ROLE` | `{env}_{app_name}_anon` | Anonymous access role |
| `PGRST_SERVER_PORT` | `3001` | Listening port |
| `PGRST_DB_CHANNEL_ENABLED` | `true` | Auto-reload on schema changes |

Image version: `postgrest/postgrest:v12.2.3` (pinned, not `:latest`)

## Ingress Routing

Each app with a database gets two Ingress resources:

### Main Ingress (`{name}`)

```yaml
spec:
  rules:
    - host: my-app.platform.company.dev
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-app
                port:
                  number: 80    # → app container :3000
```

### API Ingress (`{name}-api`)

```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /$2
spec:
  rules:
    - host: my-app.platform.company.dev
      http:
        paths:
          - path: /api/rest(/|$)(.*)
            pathType: ImplementationSpecific
            backend:
              service:
                name: my-app
                port:
                  number: 3001  # → PostgREST container :3001
```

The rewrite annotation strips `/api/rest` from the path:
- `GET /api/rest/todos` → PostgREST receives `GET /todos`
- `GET /api/rest/todos?id=eq.1` → PostgREST receives `GET /todos?id=eq.1`

Both Ingresses share the same TLS certificate and domain.

## Local vs Remote Parity

Plattr ensures that code written for local development works in production without changes.

### Environment Variable Parity

| Variable | Local (Kind) | Remote (Operator) |
|---|---|---|
| `DATABASE_URL` | `postgresql://plattr:localdev@127.0.0.1:5432/plattr?search_path={schema}` | `postgresql://{app}_app:{random}@aurora:5432/plattr?search_path={env}_{schema}` |
| `POSTGREST_URL` | `http://127.0.0.1:3001` | `https://{domain}/api/rest` |
| `POSTGREST_INTERNAL_URL` | *(not set)* | `http://localhost:3001` |
| `S3_ENDPOINT` | `http://127.0.0.1:9000` | *(AWS S3 default)* |
| `S3_BUCKET_*` | `{app}-{bucket}` | `plattr-{env}-{app}-{bucket}` |
| `AUTH_ISSUER_URL` | `http://127.0.0.1:8080/realms/{app}` | `https://auth.{baseDomain}/realms/{app}` |
| `AUTH_CLIENT_ID` | `{app}-app` | `{app}` |
| `REDIS_URL` | `redis://127.0.0.1:6379` | `redis://{managed-redis}:6379` |
| `OPENSEARCH_URL` | `http://127.0.0.1:9200` | `https://{managed-opensearch}:443` |

### Service Parity

| Service | Local | Remote |
|---|---|---|
| PostgreSQL | Pod in Kind cluster (port-forwarded to :5432) | Aurora PostgreSQL |
| Object Storage | MinIO pod (port-forwarded to :9000) | AWS S3 |
| Authentication | Keycloak pod (port-forwarded to :8080) | Keycloak on EKS (HA) |
| REST API | PostgREST pod (port-forwarded to :3001) | PostgREST sidecar |
| Redis | Redis pod (port-forwarded to :6379) | Managed Redis |
| OpenSearch | OpenSearch pod (port-forwarded to :9200) | Managed OpenSearch |
| App Server | Native dev server (run manually) | Production build in container |
| Container Registry | Local registry on :5050 | ECR |

### What Differs

- **TLS**: Local uses HTTP, remote uses HTTPS (cert-manager + Let's Encrypt)
- **DNS**: Local uses `localhost` via port-forwards, remote uses real domains (external-dns + Route 53)
- **Scaling**: Local is single-instance, remote uses HPA
- **Storage credentials**: Local uses MinIO defaults, remote uses IRSA
- **Database passwords**: Local uses `localdev`, remote uses random 32-byte hex
- **Dev server**: Local runs natively (you start it), remote runs as a container
- **Registry**: Local uses `localhost:5050`, remote uses ECR

## Preview Environment Architecture

```
PreviewEnvironment CR
        │
        v
┌───────────────────────────────────────────┐
│  preview-my-app-pr-42 (namespace)          │
│                                            │
│  ┌──────────────┐  ┌──────────────┐       │
│  │  Deployment   │  │   Service    │       │
│  │ my-app-pr42   │  │ my-app-pr42  │       │
│  │ (app +        │  │ :80, :3001   │       │
│  │  postgrest)   │  │              │       │
│  └──────────────┘  └──────────────┘       │
│  ┌──────────────┐  ┌──────────────┐       │
│  │   Ingress     │  │   Secret     │       │
│  │ pr-42.app.    │  │ my-app-      │       │
│  │  preview.     │  │  pr42-db     │       │
│  │  domain.dev   │  │              │       │
│  └──────────────┘  └──────────────┘       │
└───────────────────────────────────────────┘
```

Key properties:
- **Isolated namespace** per preview — no cross-contamination
- **Own database schema** — `my_app_pr42` (separate from production)
- **Own S3 buckets** — `plattr-preview-my-app-pr42-uploads`
- **Reduced scaling** — min 1, max 2 replicas
- **TTL-based cleanup** — controller sweeps every 5 minutes, deletes expired previews
- **Cascading deletion** — namespace deletion removes all child resources

### TTL Controller

```
Every 5 minutes:
  1. List all PreviewEnvironment CRs
  2. For each: check status.expiresAt
  3. If expired:
     a. cleanupPreview() — delete database schema, S3 buckets, namespace
     b. Delete PreviewEnvironment CR
```

TTL format: `72h` (default), `5m`, `2h`, `3d`
