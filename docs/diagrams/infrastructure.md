# Plattr Infrastructure Architecture

## Final EKS Infrastructure Setup

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              AWS Account (ca-central-1)                         │
│                                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │                    VPC (public + private subnets, 2 AZs)                  │  │
│  │                                                                           │  │
│  │  ┌─ Public Subnets ────────────────────────────────────────────────────┐  │  │
│  │  │                                                                     │  │  │
│  │  │   ┌──────────────┐        ┌──────────────┐                         │  │  │
│  │  │   │  NAT Gateway │        │  Network LB  │◄──── internet traffic   │  │  │
│  │  │   └──────┬───────┘        └──────┬───────┘                         │  │  │
│  │  └──────────┼───────────────────────┼─────────────────────────────────┘  │  │
│  │             │                       │                                     │  │
│  │  ┌─ Private Subnets ───────────────┼─────────────────────────────────┐  │  │
│  │  │          │                       │                                 │  │  │
│  │  │  ┌───────┴───────────────────────┴──────────────────────────────┐ │  │  │
│  │  │  │                  EKS Cluster (K8s 1.31)                      │ │  │  │
│  │  │  │              Managed Node Group: t3.large (2-4)              │ │  │  │
│  │  │  │              OIDC Provider (for IRSA)                        │ │  │  │
│  │  │  │                                                              │ │  │  │
│  │  │  │  ┌────────────────── plattr-system ns ────────────────────┐ │ │  │  │
│  │  │  │  │                                                        │ │ │  │  │
│  │  │  │  │  ┌─────────────────┐   ┌────────────────────────────┐ │ │ │  │  │
│  │  │  │  │  │ Plattr Operator │   │ Keycloak (StatefulSet, 2r) │ │ │ │  │  │
│  │  │  │  │  │   (Deployment)  │   │   Auth provider (OIDC)     │ │ │ │  │  │
│  │  │  │  │  │   IRSA role     │   │   External PostgreSQL      │ │ │ │  │  │
│  │  │  │  │  │   Leader elect  │   │   HTTPS Ingress            │ │ │ │  │  │
│  │  │  │  │  └─────────────────┘   └────────────────────────────┘ │ │ │  │  │
│  │  │  │  │                                                        │ │ │  │  │
│  │  │  │  │  ┌──────────────┐ ┌──────────────┐ ┌───────────────┐ │ │ │  │  │
│  │  │  │  │  │ cert-manager │ │ external-dns │ │ ingress-nginx │ │ │ │  │  │
│  │  │  │  │  │ Let's Encrypt│ │  Route 53    │ │   (NLB)       │ │ │ │  │  │
│  │  │  │  │  └──────────────┘ └──────────────┘ └───────────────┘ │ │ │  │  │
│  │  │  │  └────────────────────────────────────────────────────────┘ │ │  │  │
│  │  │  │                                                              │ │  │  │
│  │  │  │  ┌─── production ns ──┐  ┌─── staging ns ──┐  ┌─ uat ns ─┐ │ │  │  │
│  │  │  │  │  App Deployments   │  │ App Deployments  │  │ App Dep. │ │ │  │  │
│  │  │  │  │  + PostgREST       │  │ + PostgREST      │  │ + PGRST  │ │ │  │  │
│  │  │  │  │  Services/Ingress  │  │ Services/Ingress │  │ Svc/Ing  │ │ │  │  │
│  │  │  │  │  HPA (2-20)        │  │ HPA (2-20)       │  │ HPA      │ │ │  │  │
│  │  │  │  │  Resource Quotas   │  │ Resource Quotas  │  │ Quotas   │ │ │  │  │
│  │  │  │  └────────────────────┘  └──────────────────┘  └──────────┘ │ │  │  │
│  │  │  │                                                              │ │  │  │
│  │  │  │  ┌─── preview-app-pr-* ns (dynamic, TTL-based) ──────────┐ │ │  │  │
│  │  │  │  │  Isolated namespace per PR                             │ │ │  │  │
│  │  │  │  │  Deployment + PostgREST sidecar (HPA: 1-2)            │ │ │  │  │
│  │  │  │  │  Own DB schema, own S3 buckets, own Keycloak realm    │ │ │  │  │
│  │  │  │  │  Auto-cleanup after 72h (TTL controller every 5 min)  │ │ │  │  │
│  │  │  │  └───────────────────────────────────────────────────────┘ │ │  │  │
│  │  │  └──────────────────────────────────────────────────────────────┘ │  │  │
│  │  │                              │                                     │  │  │
│  │  │                              │ port 5432 (SG rule)                 │  │  │
│  │  │                              ▼                                     │  │  │
│  │  │  ┌──────────────────────────────────────────────────────────────┐ │  │  │
│  │  │  │        Aurora PostgreSQL Serverless v2 (16.4)                │ │  │  │
│  │  │  │        0.5 - 4 ACU, database: plattr                        │ │  │  │
│  │  │  │        Schema-per-app isolation (env-prefixed)               │ │  │  │
│  │  │  │        prod_app / staging_app / uat_app / app_pr42           │ │  │  │
│  │  │  └──────────────────────────────────────────────────────────────┘ │  │  │
│  │  └────────────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│  ┌─ AWS Services (outside VPC) ──────────────────────────────────────────────┐ │
│  │                                                                            │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐  ┌───────────┐  │ │
│  │  │     S3       │  │     ECR      │  │ Secrets Manager │  │ Route 53  │  │ │
│  │  │              │  │              │  │                 │  │           │  │ │
│  │  │ Bucket/app/  │  │ plattr-      │  │ plattr/db-admin │  │ Hosted    │  │ │
│  │  │ env:         │  │   operator   │  │ (Aurora admin   │  │ Zone for  │  │ │
│  │  │ plattr-prod- │  │ plattr-apps  │  │  credentials)  │  │ baseDomain│  │ │
│  │  │   app-uploads│  │              │  │                 │  │           │  │ │
│  │  │ plattr-stg-  │  │ (25/50 img   │  │                 │  │ external- │  │ │
│  │  │   app-uploads│  │  retention)  │  │                 │  │ dns auto  │  │ │
│  │  └──────────────┘  └──────────────┘  └─────────────────┘  └───────────┘  │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│  ┌─ IAM ─────────────────────────────────────────────────────────────────────┐ │
│  │  GitHub OIDC Provider (keyless CI auth)                                    │ │
│  │  CI Deploy Role  — any branch → ECR push + EKS describe (non-prod)        │ │
│  │  Prod Deploy Role — main branch only → production deployments             │ │
│  │  Operator IRSA Role — S3 + Secrets Manager + STS                          │ │
│  │  kubectl IAM Role — cluster admin access                                   │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘


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

  {app}.{baseDomain}                        → production
  {app}.staging.{baseDomain}                → staging
  {app}.uat.{baseDomain}                    → uat
  pr-{N}.{app}.preview.{baseDomain}         → preview


## Pod Architecture (per app with database)

  ┌──────────────────────────────────────────────┐
  │                    Pod                        │
  │                                               │
  │  ┌─────────────────┐  ┌───────────────────┐  │
  │  │  App Container   │  │ PostgREST Sidecar │  │
  │  │  (from ECR)      │  │ v12.2.3           │  │
  │  │  port: 3000      │  │ port: 3001        │  │
  │  │                  │  │ 50m CPU, 64Mi mem │  │
  │  │  Env vars from:  │  │                   │  │
  │  │  - {name}-db     │  │ Auto-reload via   │  │
  │  │    (Secret)      │  │ LISTEN/NOTIFY     │  │
  │  │  - {name}-storage│  │                   │  │
  │  │    (ConfigMap)   │  │ Schema:           │  │
  │  │  - {name}-auth   │  │ {env}_{app_name}  │  │
  │  │    (ConfigMap)   │  │                   │  │
  │  └─────────────────┘  └───────────────────┘  │
  └──────────────────────────────────────────────┘
           │                        │
           │                        │
           ▼                        ▼
     ┌───────────┐          ┌───────────┐
     │  Service   │          │  Service   │
     │  port: 80  │          │ port: 3001 │
     └───────────┘          └───────────┘
           │                        │
           ▼                        ▼
     ┌───────────┐          ┌────────────────┐
     │  Ingress   │          │ Ingress (API)  │
     │  {name}    │          │ {name}-api     │
     │  all paths │          │ /api/rest/*    │
     └───────────┘          └────────────────┘


## CDK Stack Breakdown

  ┌─────────────────────────────────────────────────────┐
  │              PlattrInfraStack                        │
  │  VPC, EKS, Aurora, OIDC, Security Groups            │
  │  Deploy first — takes 20-30 min                     │
  └──────────────────────┬──────────────────────────────┘
                         │ outputs: ClusterName, KubectlRoleArn,
                         │          OidcProviderArn, AuroraEndpoint
                         ▼
  ┌─────────────────────────────────────────────────────┐
  │              PlattrOperatorStack                      │
  │  plattr-system ns, CRDs, IRSA, Helm chart,          │
  │  cert-manager, external-dns, ingress-nginx,          │
  │  Keycloak, env namespaces + quotas, ECR (operator)   │
  └──────────────────────┬──────────────────────────────┘
                         │
                         ▼
  ┌─────────────────────────────────────────────────────┐
  │              PlattrCicdStack                          │
  │  GitHub OIDC provider, ECR (apps),                   │
  │  CI Deploy Role (any branch, non-prod),              │
  │  Prod Deploy Role (main branch only)                 │
  └─────────────────────────────────────────────────────┘
```
