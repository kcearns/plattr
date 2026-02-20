# Plattr Infrastructure Architecture

## Two-Account Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         Non-Prod Account (ca-central-1)                         │
│                                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │                    VPC (public + private subnets, 2 AZs)                  │  │
│  │                                                                           │  │
│  │  ┌─ Public Subnets ────────────────────────────────────────────────────┐  │  │
│  │  │   ┌──────────────┐        ┌──────────────┐                         │  │  │
│  │  │   │  NAT Gateway │        │  Network LB  │◄──── internet traffic   │  │  │
│  │  │   └──────┬───────┘        └──────┬───────┘                         │  │  │
│  │  └──────────┼───────────────────────┼─────────────────────────────────┘  │  │
│  │             │                       │                                     │  │
│  │  ┌─ Private Subnets ───────────────┼─────────────────────────────────┐  │  │
│  │  │  ┌───────┴───────────────────────┴──────────────────────────────┐ │  │  │
│  │  │  │                EKS Cluster: plattr-nonprod (K8s 1.31)        │ │  │  │
│  │  │  │              Managed Node Group: t3.large (2-4)              │ │  │  │
│  │  │  │              OIDC Provider (for IRSA)                        │ │  │  │
│  │  │  │                                                              │ │  │  │
│  │  │  │  ┌────────────────── plattr-system ns ────────────────────┐ │ │  │  │
│  │  │  │  │                                                        │ │ │  │  │
│  │  │  │  │  ┌─────────────────┐   ┌────────────────────────────┐ │ │ │  │  │
│  │  │  │  │  │ Plattr Operator │   │ Keycloak (StatefulSet, 2r) │ │ │ │  │  │
│  │  │  │  │  │  (container     │   │   Auth provider (OIDC)     │ │ │ │  │  │
│  │  │  │  │  │   mode)         │   │   External PostgreSQL      │ │ │ │  │  │
│  │  │  │  │  │   IRSA role     │   │   HTTPS Ingress            │ │ │ │  │  │
│  │  │  │  │  └─────────────────┘   └────────────────────────────┘ │ │ │  │  │
│  │  │  │  │                                                        │ │ │  │  │
│  │  │  │  │  ┌────────┐ ┌──────┐ ┌─────┐ ┌──────────┐            │ │ │  │  │
│  │  │  │  │  │  PG    │ │MinIO │ │Redis│ │OpenSearch │            │ │ │  │  │
│  │  │  │  │  │ :5432  │ │:9000 │ │:6379│ │  :9200   │            │ │ │  │  │
│  │  │  │  │  └────────┘ └──────┘ └─────┘ └──────────┘            │ │ │  │  │
│  │  │  │  │                                                        │ │ │  │  │
│  │  │  │  │  ┌──────────────┐ ┌──────────────┐ ┌───────────────┐ │ │ │  │  │
│  │  │  │  │  │ cert-manager │ │ external-dns │ │ ingress-nginx │ │ │ │  │  │
│  │  │  │  │  └──────────────┘ └──────────────┘ └───────────────┘ │ │ │  │  │
│  │  │  │  └────────────────────────────────────────────────────────┘ │ │  │  │
│  │  │  │                                                              │ │  │  │
│  │  │  │  ┌─── staging ns ──┐  ┌─── uat ns ──┐                      │ │  │  │
│  │  │  │  │ App Deployments  │  │ App Deploy. │                      │ │  │  │
│  │  │  │  │ + PostgREST      │  │ + PostgREST │                      │ │  │  │
│  │  │  │  └──────────────────┘  └─────────────┘                      │ │  │  │
│  │  │  │                                                              │ │  │  │
│  │  │  │  ┌─── preview-app-pr-* ns (dynamic, TTL-based) ──────────┐ │ │  │  │
│  │  │  │  │  Isolated namespace per PR                             │ │ │  │  │
│  │  │  │  │  Auto-cleanup after 72h (TTL controller)               │ │ │  │  │
│  │  │  │  └───────────────────────────────────────────────────────┘ │ │  │  │
│  │  │  └──────────────────────────────────────────────────────────────┘ │  │  │
│  │  │                              │                                     │  │  │
│  │  │                              │ port 5432 (containerized PG)        │  │  │
│  │  └──────────────────────────────┼─────────────────────────────────────┘  │  │
│  └─────────────────────────────────┼─────────────────────────────────────────┘  │
│                                                                                 │
│  ┌─ AWS Services ──────────────────────────────────────────────────────────┐   │
│  │  ┌──────────┐  ┌──────────┐  ┌─────────────────┐  ┌───────────┐       │   │
│  │  │    S3    │  │   ECR    │  │ Secrets Manager │  │ Route 53  │       │   │
│  │  │          │  │ plattr-  │  │ plattr/db-admin │  │           │       │   │
│  │  │ Bucket/  │  │  operator│  │                 │  │ *.nonprod │       │   │
│  │  │ app/env  │  │ plattr-  │  │                 │  │ .company  │       │   │
│  │  │          │  │  apps    │  │                 │  │  .dev     │       │   │
│  │  └──────────┘  └──────────┘  └─────────────────┘  └───────────┘       │   │
│  └────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  ┌─ IAM ─────────────────────────────────────────────────────────────────────┐ │
│  │  GitHub OIDC Provider (keyless CI auth)                                    │ │
│  │  CI Deploy Role  — any branch → ECR push + EKS describe (non-prod)        │ │
│  │  Prod Deploy Role — main branch only → sts:AssumeRole into prod account   │ │
│  │  Operator IRSA Role — S3 + Secrets Manager + STS                          │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘


┌─────────────────────────────────────────────────────────────────────────────────┐
│                          Prod Account (ca-central-1)                            │
│                                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │                    VPC (public + private subnets, 2 AZs)                  │  │
│  │                                                                           │  │
│  │  ┌─ Public Subnets ────────────────────────────────────────────────────┐  │  │
│  │  │   ┌──────────────┐        ┌──────────────┐                         │  │  │
│  │  │   │  NAT Gateway │        │  Network LB  │◄──── internet traffic   │  │  │
│  │  │   └──────┬───────┘        └──────┬───────┘                         │  │  │
│  │  └──────────┼───────────────────────┼─────────────────────────────────┘  │  │
│  │             │                       │                                     │  │
│  │  ┌─ Private Subnets ───────────────┼─────────────────────────────────┐  │  │
│  │  │  ┌───────┴───────────────────────┴──────────────────────────────┐ │  │  │
│  │  │  │                EKS Cluster: plattr-prod (K8s 1.31)           │ │  │  │
│  │  │  │              Managed Node Group: t3.xlarge (2-6)             │ │  │  │
│  │  │  │              OIDC Provider (for IRSA)                        │ │  │  │
│  │  │  │                                                              │ │  │  │
│  │  │  │  ┌────────────────── plattr-system ns ────────────────────┐ │ │  │  │
│  │  │  │  │                                                        │ │ │  │  │
│  │  │  │  │  ┌─────────────────┐   ┌────────────────────────────┐ │ │ │  │  │
│  │  │  │  │  │ Plattr Operator │   │ Keycloak (StatefulSet, 2r) │ │ │ │  │  │
│  │  │  │  │  │  (managed mode) │   │   Auth provider (OIDC)     │ │ │ │  │  │
│  │  │  │  │  │  REDIS_ENDPOINT │   │   External PostgreSQL      │ │ │ │  │  │
│  │  │  │  │  │  OPENSEARCH_    │   │   HTTPS Ingress            │ │ │ │  │  │
│  │  │  │  │  │   ENDPOINT set  │   │                            │ │ │ │  │  │
│  │  │  │  │  └─────────────────┘   └────────────────────────────┘ │ │ │  │  │
│  │  │  │  │                                                        │ │ │  │  │
│  │  │  │  │  ┌──────────────┐ ┌──────────────┐ ┌───────────────┐ │ │ │  │  │
│  │  │  │  │  │ cert-manager │ │ external-dns │ │ ingress-nginx │ │ │ │  │  │
│  │  │  │  │  └──────────────┘ └──────────────┘ └───────────────┘ │ │ │  │  │
│  │  │  │  │                                                        │ │ │  │  │
│  │  │  │  │  (No containerized PG/MinIO/Redis/OpenSearch pods)    │ │ │  │  │
│  │  │  │  └────────────────────────────────────────────────────────┘ │ │  │  │
│  │  │  │                                                              │ │  │  │
│  │  │  │  ┌─── production ns ──────────────────────────────────────┐ │ │  │  │
│  │  │  │  │  App Deployments + PostgREST sidecar                   │ │ │  │  │
│  │  │  │  │  Services, Ingress, HPA (2-20)                         │ │ │  │  │
│  │  │  │  │  Resource Quotas (16 CPU, 32Gi)                        │ │ │  │  │
│  │  │  │  └────────────────────────────────────────────────────────┘ │ │  │  │
│  │  │  └──────────────────────────────────────────────────────────────┘ │  │  │
│  │  │             │                  │                   │               │  │  │
│  │  │             │ port 5432        │ port 6379         │ port 443     │  │  │
│  │  │             ▼                  ▼                   ▼               │  │  │
│  │  │  ┌──────────────────┐ ┌──────────────────┐ ┌───────────────────┐ │  │  │
│  │  │  │ Aurora Serverless │ │ ElastiCache      │ │ OpenSearch Service│ │  │  │
│  │  │  │ v2 (PG 16.4)     │ │ Serverless       │ │ plattr-prod-     │ │  │  │
│  │  │  │ 1-8 ACU          │ │ (Redis 7)        │ │   search         │ │  │  │
│  │  │  │ plattr DB         │ │ plattr-prod-     │ │ t3.medium.search │ │  │  │
│  │  │  │                  │ │   redis           │ │ 2 data nodes     │ │  │  │
│  │  │  └──────────────────┘ └──────────────────┘ └───────────────────┘ │  │  │
│  │  └──────────────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│  ┌─ AWS Services ──────────────────────────────────────────────────────────┐   │
│  │  ┌──────────┐  ┌───────────────────┐  ┌───────────┐                    │   │
│  │  │    S3    │  │ Secrets Manager   │  │ Route 53  │                    │   │
│  │  │          │  │ plattr/aurora-    │  │           │                    │   │
│  │  │ Bucket/  │  │   admin-prod      │  │ *.prod    │                    │   │
│  │  │ app/env  │  │                   │  │ .company  │                    │   │
│  │  │          │  │                   │  │  .dev     │                    │   │
│  │  └──────────┘  └───────────────────┘  └───────────┘                    │   │
│  └────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  ┌─ IAM ─────────────────────────────────────────────────────────────────────┐ │
│  │  plattr-ci-deploy-prod — trusted by non-prod's Prod Deploy Role          │ │
│  │  plattr-prod-ecr-pull — cross-account ECR pull from non-prod             │ │
│  │  Operator IRSA Role — S3 + Secrets Manager + STS                          │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘
```


## Cross-Account Image Flow

```
Non-Prod Account                        Prod Account
┌──────────┐                          ┌──────────────────┐
│   ECR    │    cross-account pull    │  EKS (prod)      │
│ plattr-  │ ◄─────────────────────── │  pulls images    │
│  apps    │    via ECR pull role     │  for production   │
│ plattr-  │                          │  deployments      │
│  operator│                          └──────────────────┘
└──────────┘
```


## DNS & Traffic Flow

    Internet
       │
       ▼
  ┌─────────┐    ┌───────────────┐    ┌──────────────────────────────────┐
  │ Route 53│───▶│  Network LB   │───▶│  ingress-nginx (in EKS)         │
  │         │    │  (public)     │    │                                  │
  │ Records │    └───────────────┘    │  Routing rules:                 │
  │ managed │                         │  app.domain.dev      → app:80   │
  │ by      │                         │  app.domain.dev/api/ → app:3001 │
  │ external│                         │  app.stg.domain.dev  → app:80   │
  │ -dns    │                         │  pr-N.app.preview.   → app:80   │
  └─────────┘                         └──────────────────────────────────┘
                                              │
                                              ▼
                                      ┌──────────────────┐
                                      │ TLS terminated by │
                                      │ cert-manager      │
                                      │ (Let's Encrypt)   │
                                      └──────────────────┘


## Domain Pattern

  {app}.{baseDomain}                        → production (prod account)
  {app}.staging.{baseDomain}                → staging (non-prod account)
  {app}.uat.{baseDomain}                    → uat (non-prod account)
  pr-{N}.{app}.preview.{baseDomain}         → preview (non-prod account)


## Pod Architecture (per app with database)

  ┌──────────────────────────────────────────────────────┐
  │                    Pod                                │
  │                                                       │
  │  ┌─────────────────┐  ┌───────────────────┐          │
  │  │  App Container   │  │ PostgREST Sidecar │          │
  │  │  (from ECR)      │  │ v12.2.3           │          │
  │  │  port: 3000      │  │ port: 3001        │          │
  │  │                  │  │ 50m CPU, 64Mi mem │          │
  │  │  Env vars from:  │  │                   │          │
  │  │  - {name}-db     │  │ Auto-reload via   │          │
  │  │    (Secret)      │  │ LISTEN/NOTIFY     │          │
  │  │  - {name}-storage│  │                   │          │
  │  │    (ConfigMap)   │  │ Schema:           │          │
  │  │  - {name}-auth   │  │ {env}_{app_name}  │          │
  │  │    (ConfigMap)   │  │                   │          │
  │  │  - {name}-redis  │  └───────────────────┘          │
  │  │    (ConfigMap)   │                                  │
  │  │  - {name}-search │                                  │
  │  │    (ConfigMap)   │                                  │
  │  └─────────────────┘                                   │
  └──────────────────────────────────────────────────────┘


## CDK Stack Breakdown

  ┌─────────────────────────────────────────────────────┐
  │ Non-Prod: PlattrInfraStack                          │
  │  VPC, EKS (plattr-nonprod), Aurora, OIDC, SGs       │
  └──────────────────────┬──────────────────────────────┘
                         │ outputs: ClusterName, KubectlRoleArn,
                         │          OidcProviderArn, AuroraEndpoint
                         ▼
  ┌─────────────────────────────────────────────────────┐
  │ Non-Prod: PlattrOperatorStack                       │
  │  plattr-system ns, CRDs, IRSA, Helm chart,          │
  │  cert-manager, external-dns, ingress-nginx,          │
  │  Keycloak, env namespaces (staging+uat+production)   │
  └─────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────┐
  │ Prod: PlattrProdInfraStack                           │
  │  VPC, EKS (plattr-prod), Aurora (1-8 ACU),          │
  │  ElastiCache Serverless (Redis 7),                   │
  │  OpenSearch Service (2-node), SGs, cross-acct ECR    │
  └──────────────────────┬──────────────────────────────┘
                         │ outputs: + RedisEndpoint, OpenSearchEndpoint
                         ▼
  ┌─────────────────────────────────────────────────────┐
  │ Prod: PlattrProdOperatorStack                        │
  │  plattr-system ns, CRDs, IRSA, Helm chart,          │
  │  cert-manager, external-dns, ingress-nginx,          │
  │  Keycloak, production namespace only                 │
  │  Operator env: REDIS_ENDPOINT, OPENSEARCH_ENDPOINT   │
  └─────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────┐
  │ PlattrCicdStack (non-prod account)                   │
  │  GitHub OIDC provider, ECR (apps),                   │
  │  CI Deploy Role (any branch, non-prod),              │
  │  Prod Deploy Role (main only, cross-account assume)  │
  └─────────────────────────────────────────────────────┘
