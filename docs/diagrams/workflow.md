# Plattr Workflow: Local Dev → EKS Staging

## End-to-End Developer Workflow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DEVELOPER WORKSTATION                               │
│                                                                             │
│  ┌─── 1. Initialize ───────────────────────────────────────────────────┐   │
│  │                                                                     │   │
│  │  $ plattr init                                                      │   │
│  │    ├── Interactive wizard (name, framework, services)               │   │
│  │    ├── Generates plattr.yaml                                        │   │
│  │    └── Generates .github/workflows/plattr-deploy.yml                │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              ▼                                              │
│  ┌─── 2. Local Development ────────────────────────────────────────────┐   │
│  │                                                                     │   │
│  │  $ plattr dev                                                       │   │
│  │    ├── Creates Kind cluster + local registry (:5050)                │   │
│  │    ├── Deploys infra pods (plattr-local namespace):                 │   │
│  │    │     PostgreSQL :5432                                           │   │
│  │    │     PostgREST  :3001                                           │   │
│  │    │     MinIO      :9000/:9001                                     │   │
│  │    │     Keycloak   :8080                                           │   │
│  │    │     Redis      :6379                                           │   │
│  │    │     OpenSearch  :9200/:5601                                    │   │
│  │    ├── Port-forwards all services to localhost                      │   │
│  │    └── Writes .plattr/{appName}.env                                 │   │
│  │                                                                     │   │
│  │  $ source .plattr/my-app.env                                        │   │
│  │  $ npx next dev              ← developer runs their own dev server  │   │
│  │                                                                     │   │
│  │  ┌──────────────────────────────────────────────────────────────┐   │   │
│  │  │              Kind Cluster (plattr-local ns)                  │   │   │
│  │  │  ┌─────┐ ┌───────┐ ┌─────┐ ┌────────┐ ┌─────┐ ┌────────┐ │   │   │
│  │  │  │ PG  │ │ PGRST │ │MinIO│ │Keycloak│ │Redis│ │OpenSrch│ │   │   │
│  │  │  │:5432│ │ :3001 │ │:9000│ │ :8080  │ │:6379│ │ :9200  │ │   │   │
│  │  │  └─────┘ └───────┘ └─────┘ └────────┘ └─────┘ └────────┘ │   │   │
│  │  └──────────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              ▼                                              │
│  ┌─── 3. Iterate ──────────────────────────────────────────────────────┐   │
│  │                                                                     │   │
│  │  $ plattr db migrate --engine prisma    (run migrations)            │   │
│  │  $ plattr db seed                       (seed data)                 │   │
│  │  $ plattr test                          (auto-detect runner)        │   │
│  │  $ plattr db shell                      (psql into local DB)        │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              ▼                                              │
│  ┌─── 4. Local Deploy (optional validation) ───────────────────────────┐   │
│  │                                                                     │   │
│  │  $ plattr deploy local                                              │   │
│  │    ├── Run tests (auto-detected)                                    │   │
│  │    ├── Build production image (Dagger)                              │   │
│  │    ├── Push to local registry (localhost:5050)                      │   │
│  │    ├── Security scan (Trivy — HIGH/CRITICAL)                       │   │
│  │    └── Deploy to Kind cluster + port-forward                       │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              ▼                                              │
│  ┌─── 5. Push Code ───────────────────────────────────────────────────┐   │
│  │                                                                     │   │
│  │  $ git push origin feature-branch                                   │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           GITHUB                                            │
│                                                                             │
│  ┌─── 6. CI/CD Pipeline (plattr-deploy.yml) ──────────────────────────┐   │
│  │                                                                     │   │
│  │   Trigger: push to branch                                           │   │
│  │                                                                     │   │
│  │   ┌──────────────────────────────────────────────────────────────┐  │   │
│  │   │  Step 1: Authenticate                                        │  │   │
│  │   │    AWS OIDC auth → assume CI Deploy Role (keyless)           │  │   │
│  │   └──────────────────────────┬───────────────────────────────────┘  │   │
│  │                              │                                      │   │
│  │   ┌──────────────────────────▼───────────────────────────────────┐  │   │
│  │   │  Step 2: Test                                                │  │   │
│  │   │    Dagger: ephemeral test with clean state (--ci mode)       │  │   │
│  │   └──────────────────────────┬───────────────────────────────────┘  │   │
│  │                              │                                      │   │
│  │   ┌──────────────────────────▼───────────────────────────────────┐  │   │
│  │   │  Step 3: Build                                               │  │   │
│  │   │    Dagger: build production container image                  │  │   │
│  │   └──────────────────────────┬───────────────────────────────────┘  │   │
│  │                              │                                      │   │
│  │   ┌──────────────────────────▼───────────────────────────────────┐  │   │
│  │   │  Step 4: Push to ECR                                         │  │   │
│  │   │    Push image → {account}.dkr.ecr.{region}/plattr-apps      │  │   │
│  │   └──────────────────────────┬───────────────────────────────────┘  │   │
│  │                              │                                      │   │
│  │   ┌──────────────────────────▼───────────────────────────────────┐  │   │
│  │   │  Step 5: Deploy to Staging                                   │  │   │
│  │   │    kubectl apply Application CR with updated imageRef        │  │   │
│  │   │    → targets: staging namespace                              │  │   │
│  │   │                                                              │  │   │
│  │   │    ⚠ NOTE: Currently stub/echo placeholders (known gap)     │  │   │
│  │   └──────────────────────────┬───────────────────────────────────┘  │   │
│  │                              │                                      │   │
│  └──────────────────────────────┼──────────────────────────────────────┘   │
└─────────────────────────────────┼───────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         EKS CLUSTER                                         │
│                                                                             │
│  ┌─── 7. Operator Reconciliation ──────────────────────────────────────┐   │
│  │                                                                     │   │
│  │   Application CR applied to staging namespace                       │   │
│  │          │                                                          │   │
│  │          ▼                                                          │   │
│  │   ┌──────────────────────────────────────────────────────────┐     │   │
│  │   │              Plattr Operator (plattr-system)              │     │   │
│  │   │                                                          │     │   │
│  │   │  Informer detects new/updated Application CR             │     │   │
│  │   │  Checks metadata.generation vs last reconciled           │     │   │
│  │   │                                                          │     │   │
│  │   │  Reconciliation pipeline (sequential):                   │     │   │
│  │   │                                                          │     │   │
│  │   │  ┌─────────────────────────────────────────────────┐    │     │   │
│  │   │  │ ① reconcileDatabase()                           │    │     │   │
│  │   │  │   Aurora: CREATE schema staging_my_app          │    │     │   │
│  │   │  │   CREATE ROLE staging_my_app_app (CRUD)         │    │     │   │
│  │   │  │   CREATE ROLE staging_my_app_anon (PostgREST)   │    │     │   │
│  │   │  │   → Secret: my-app-db (DATABASE_URL)            │    │     │   │
│  │   │  └────────────────────┬────────────────────────────┘    │     │   │
│  │   │                       ▼                                  │     │   │
│  │   │  ┌─────────────────────────────────────────────────┐    │     │   │
│  │   │  │ ② reconcileStorage()                            │    │     │   │
│  │   │  │   S3: CREATE plattr-staging-my-app-uploads      │    │     │   │
│  │   │  │   Set CORS, public policy if configured         │    │     │   │
│  │   │  │   → ConfigMap: my-app-storage                   │    │     │   │
│  │   │  └────────────────────┬────────────────────────────┘    │     │   │
│  │   │                       ▼                                  │     │   │
│  │   │  ┌─────────────────────────────────────────────────┐    │     │   │
│  │   │  │ ③ reconcileAuth()                               │    │     │   │
│  │   │  │   Keycloak: CREATE realm, OIDC client           │    │     │   │
│  │   │  │   Configure identity providers                  │    │     │   │
│  │   │  │   → ConfigMap: my-app-auth                      │    │     │   │
│  │   │  └────────────────────┬────────────────────────────┘    │     │   │
│  │   │                       ▼                                  │     │   │
│  │   │  ┌─────────────────────────────────────────────────┐    │     │   │
│  │   │  │ ④ reconcileWorkload()                           │    │     │   │
│  │   │  │   CREATE/UPDATE:                                │    │     │   │
│  │   │  │     ServiceAccount: my-app                      │    │     │   │
│  │   │  │     Deployment: my-app                          │    │     │   │
│  │   │  │       ├── app container (from ECR imageRef)     │    │     │   │
│  │   │  │       └── PostgREST sidecar (v12.2.3)          │    │     │   │
│  │   │  │     Service: my-app (:80, :3001)                │    │     │   │
│  │   │  │     Ingress: my-app (all paths)                 │    │     │   │
│  │   │  │     Ingress: my-app-api (/api/rest/*)           │    │     │   │
│  │   │  │     HPA: my-app (min:2, max:20, cpu:70%)       │    │     │   │
│  │   │  └────────────────────┬────────────────────────────┘    │     │   │
│  │   │                       ▼                                  │     │   │
│  │   │  ┌─────────────────────────────────────────────────┐    │     │   │
│  │   │  │ ⑤ reconcileStatus()                             │    │     │   │
│  │   │  │   Update conditions:                            │    │     │   │
│  │   │  │     DatabaseReady: True                         │    │     │   │
│  │   │  │     StorageReady: True                          │    │     │   │
│  │   │  │     AuthReady: True                             │    │     │   │
│  │   │  │     DeploymentReady: True                       │    │     │   │
│  │   │  │     IngressReady: True                          │    │     │   │
│  │   │  │   Phase: Pending → Provisioning → Running       │    │     │   │
│  │   │  └─────────────────────────────────────────────────┘    │     │   │
│  │   └──────────────────────────────────────────────────────────┘     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              ▼                                              │
│  ┌─── 8. App is Live ─────────────────────────────────────────────────┐   │
│  │                                                                     │   │
│  │   external-dns creates Route 53 record:                             │   │
│  │     my-app.staging.nonprod.yourcompany.dev → NLB                    │   │
│  │                                                                     │   │
│  │   cert-manager provisions TLS certificate (Let's Encrypt)           │   │
│  │                                                                     │   │
│  │   Traffic flow:                                                     │   │
│  │     Browser → Route 53 → NLB → ingress-nginx → Service → Pod       │   │
│  │                                                                     │   │
│  │   Developer can now:                                                │   │
│  │     $ plattr status --env staging                                   │   │
│  │     $ plattr logs --env staging -f                                  │   │
│  │     $ plattr db connect --env staging                               │   │
│  │     $ plattr env set KEY=VAL --env staging                          │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘


## Preview Environment Flow (PR-based)

  Developer opens PR #42
         │
         ▼
  CI applies PreviewEnvironment CR ──────────────────────────────────┐
         │                                                           │
         ▼                                                           ▼
  Operator creates:                                           TTL Controller
    namespace: preview-my-app-pr-42                           (every 5 min)
    DB schema: my_app_pr42                                         │
    S3 bucket: plattr-preview-my-app-pr42-uploads                  │
    Keycloak realm                                                  │
    Deployment + PostgREST sidecar (HPA: 1-2)                     │
    Ingress: pr-42.my-app.preview.nonprod.yourcompany.dev          │
         │                                                           │
         ▼                                                           ▼
  App live at preview URL ◄──── auto-cleanup after 72h ────── TTL expired
                                  (cascading namespace delete)


## Environment Promotion Path

  ┌──────────┐    push to    ┌──────────┐   merge to   ┌────────────┐
  │  Local   │──────────────▶│ Staging  │─────────────▶│ Production │
  │  (Kind)  │   branch      │  (EKS)   │   main       │   (EKS)    │
  └──────────┘               └──────────┘               └────────────┘
       │                          │                          │
  plattr dev              CI Deploy Role             Prod Deploy Role
  HTTP, localhost         HTTPS, *.staging.domain    HTTPS, *.domain
  MinIO, local PG         Aurora, S3, Keycloak       Aurora, S3, Keycloak
  No scaling              HPA 2-20                   HPA 2-20


## What Changes Between Local and Staging

  ┌──────────────────────┬──────────────────────┬─────────────────────────┐
  │     Component        │     Local (Kind)     │     Staging (EKS)       │
  ├──────────────────────┼──────────────────────┼─────────────────────────┤
  │ Database             │ PG pod (:5432)       │ Aurora Serverless v2    │
  │ DB Schema            │ {app_name}           │ staging_{app_name}      │
  │ Object Storage       │ MinIO (:9000)        │ S3 (IRSA auth)         │
  │ Auth                 │ Keycloak dev (:8080) │ Keycloak on EKS (HTTPS)│
  │ Redis                │ Pod (:6379)          │ ⚠ Not yet implemented  │
  │ OpenSearch           │ Pod (:9200)          │ ⚠ Not yet implemented  │
  │ TLS                  │ HTTP (no TLS)        │ HTTPS (Let's Encrypt)  │
  │ DNS                  │ localhost             │ *.staging.{baseDomain} │
  │ Container Registry   │ localhost:5050        │ ECR                    │
  │ Scaling              │ Single replica        │ HPA (2-20 replicas)   │
  │ DB Credentials       │ localdev (static)    │ Random 32-byte hex     │
  │ Dev Server           │ Native (npx next)    │ Containerized          │
  └──────────────────────┴──────────────────────┴─────────────────────────┘
```
