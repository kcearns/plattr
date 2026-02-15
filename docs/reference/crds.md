# CRD Reference

Plattr defines two Custom Resource Definitions in the `platform.internal` API group.

## Application

**API Version:** `platform.internal/v1alpha1`
**Kind:** `Application`
**Plural:** `applications`
**Short Names:** `app`, `apps`
**Scope:** Namespaced

### Spec Fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `repository` | string | Yes | — | Git repository URL (e.g., `github.com/myorg/my-app`) |
| `branch` | string | No | `main` | Git branch to deploy |
| `framework` | enum | Yes | — | `nextjs`, `rails`, `static`, or `docker` |
| `environment` | enum | Yes | — | `staging`, `uat`, `production`, or `preview` |
| `imageRef` | string | No | — | Container image reference (set by CI pipeline) |
| `domain` | string | No | Auto-generated | Custom domain override |
| `envVars` | array | No | `[]` | Additional environment variables |
| `envVars[].name` | string | Yes | — | Variable name |
| `envVars[].value` | string | No | — | Variable value (plain text) |
| `envVars[].secretKeyRef` | object | No | — | Reference to a Secret key |
| `cors` | object | No | — | CORS configuration |
| `cors.origins` | string[] | No | — | Allowed origins |
| `database` | object | No | — | Database configuration |
| `database.enabled` | boolean | Yes | — | Enable PostgreSQL provisioning |
| `database.schemaName` | string | No | `name` (hyphens → underscores) | PostgreSQL schema name |
| `database.migrations.path` | string | No | `./migrations` | Migration files path |
| `database.migrations.engine` | enum | No | — | `prisma`, `knex`, or `raw` |
| `storage` | object | No | — | Object storage configuration |
| `storage.enabled` | boolean | Yes | — | Enable S3 bucket provisioning |
| `storage.buckets` | array | No | `[]` | Bucket definitions |
| `storage.buckets[].name` | string | Yes | — | Bucket name |
| `storage.buckets[].public` | boolean | No | `false` | Public read access |
| `storage.buckets[].maxFileSize` | string | No | — | Max upload size |
| `auth` | object | No | — | Authentication configuration |
| `auth.enabled` | boolean | Yes | — | Enable Keycloak realm provisioning |
| `auth.providers` | string[] | No | `[]` | Identity providers: `google`, `github`, `saml`, `oidc` |
| `scaling` | object | No | See defaults | Autoscaling configuration |
| `scaling.min` | integer | No | `2` | Minimum replicas |
| `scaling.max` | integer | No | `20` | Maximum replicas |
| `scaling.targetCPU` | integer | No | `70` | Target CPU utilization (%) |

### Status Fields

| Field | Type | Description |
|---|---|---|
| `phase` | enum | `Pending`, `Provisioning`, `Running`, `Failed`, or `Terminating` |
| `url` | string | Public URL of the deployed application |
| `conditions` | array | Detailed status of each subsystem |
| `conditions[].type` | enum | `DatabaseReady`, `StorageReady`, `AuthReady`, `DeploymentReady`, `IngressReady` |
| `conditions[].status` | enum | `"True"`, `"False"`, or `"Unknown"` |
| `conditions[].reason` | string | Machine-readable reason for the condition |
| `conditions[].message` | string | Human-readable description |
| `conditions[].lastTransitionTime` | string | ISO 8601 timestamp of last status change |

### Phase Transitions

| Phase | Meaning |
|---|---|
| `Pending` | CR created, not yet processed |
| `Provisioning` | Operator is creating resources (database, storage, deployment) |
| `Running` | All conditions are `True`, app is serving traffic |
| `Failed` | A required resource could not be created (after retries) |
| `Terminating` | CR deleted, operator is cleaning up resources |

### Example

```yaml
apiVersion: platform.internal/v1alpha1
kind: Application
metadata:
  name: my-frontend
  namespace: default
spec:
  repository: github.com/myorg/my-frontend
  branch: main
  framework: nextjs
  environment: production
  imageRef: 123456789.dkr.ecr.us-east-1.amazonaws.com/plattr-apps:my-frontend-abc123
  database:
    enabled: true
    schemaName: my_frontend
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
  scaling:
    min: 2
    max: 20
    targetCPU: 70
  domain: my-frontend.platform.company.dev
```

### Kubernetes Resources Created

When an Application is reconciled, the operator creates:

| Resource | Name | Condition |
|---|---|---|
| Secret | `{name}-db` | `database.enabled: true` |
| ConfigMap | `{name}-storage` | `storage.enabled: true` |
| ConfigMap | `{name}-auth` | `auth.enabled: true` |
| ServiceAccount | `{name}` | Always |
| Deployment | `{name}` | Always |
| Service | `{name}` | Always |
| Ingress | `{name}` | Always |
| Ingress | `{name}-api` | `database.enabled: true` |
| HPA | `{name}` | Always |

---

## PreviewEnvironment

**API Version:** `platform.internal/v1alpha1`
**Kind:** `PreviewEnvironment`
**Plural:** `previewenvironments`
**Scope:** Namespaced

### Spec Fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `applicationRef` | string | Yes | — | Name of the parent Application CR |
| `pullRequest` | integer | Yes | — | Pull request number |
| `branch` | string | Yes | — | Git branch name |
| `ttl` | string | No | `72h` | Time to live before auto-cleanup. Format: `5m`, `2h`, `3d`, `72h` |

### Status Fields

| Field | Type | Description |
|---|---|---|
| `phase` | enum | `Pending`, `Provisioning`, `Running`, `Failed`, or `Terminating` |
| `url` | string | Public URL of the preview environment |
| `expiresAt` | string | ISO 8601 timestamp when the preview will be cleaned up |

### Example

```yaml
apiVersion: platform.internal/v1alpha1
kind: PreviewEnvironment
metadata:
  name: my-frontend-pr-42
  namespace: default
spec:
  applicationRef: my-frontend
  pullRequest: 42
  branch: feature/new-login
  ttl: 72h
```

### What Gets Created

For each PreviewEnvironment, the operator:

1. Creates namespace `preview-{appName}-pr-{N}`
2. Provisions an isolated database schema (if parent app has `database.enabled`)
3. Creates isolated S3 buckets (if parent app has `storage.enabled`)
4. Deploys a workload with:
   - Name: `{appName}-pr{N}`
   - Domain: `pr-{N}.{appName}.preview.{baseDomain}`
   - Scaling: min=1, max=2
   - Full PostgREST sidecar (if database enabled)
5. Sets `status.expiresAt` based on TTL
6. Updates `status.url` with the preview URL

### TTL Cleanup

The TTL controller runs every 5 minutes and deletes PreviewEnvironments where `status.expiresAt` has passed. Cleanup cascades:

1. Delete workload resources (Deployment, Service, Ingress, HPA)
2. Delete Keycloak realm (if auth enabled)
3. Empty and delete S3 buckets (if storage enabled)
4. Drop database schema and roles (if database enabled)
5. Delete the namespace

---

## Installing CRDs

```bash
kubectl apply -f manifests/crds/application.yaml
kubectl apply -f manifests/crds/preview-environment.yaml
```

## Verifying CRDs

```bash
kubectl get crd applications.platform.internal
kubectl get crd previewenvironments.platform.internal

# List all applications
kubectl get apps -A

# Describe an application
kubectl describe app my-frontend
```
