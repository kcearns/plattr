# TODO — Security Hardening

Security review findings to address before production use.

## Critical

- [ ] **Fix wildcard OIDC configuration** — `packages/operator/src/reconcilers/auth.ts:108-109`
  - Change `redirectUris` from `https://${domain}/*` to exact callback paths (e.g., `/auth/callback`)
  - Change `webOrigins` from `['*']` to the specific app domain

- [ ] **Add security contexts to generated workloads** — `packages/operator/src/reconcilers/workload.ts:155-169`
  - Add `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`
  - Drop all capabilities: `capabilities.drop: ["ALL"]`

- [ ] **Add security context to operator Deployment** — `manifests/helm/plattr-operator/templates/deployment.yaml`
  - Same as above — Dockerfile already uses non-root user, but K8s spec should enforce it

- [ ] **Add CRD input validation** — `manifests/crds/application.yaml`
  - `imageRef`: validate registry/repo:tag format
  - `domain`: validate against RFC 1123 DNS name pattern
  - `database.schemaName`: strict regex (`^[a-z][a-z0-9_]*$`)
  - `envVars.name`: block dangerous names (`LD_PRELOAD`, `NODE_OPTIONS`, etc.)

- [ ] **Remove hardcoded Keycloak fallback credentials** — `packages/operator/src/reconcilers/auth.ts:7-9`
  - Fail loudly if `KEYCLOAK_ADMIN_PASSWORD` is not set instead of defaulting to `admin`

## High

- [ ] **Fix SQL template literal injection risk** — `packages/shared/src/sql.ts`
  - Validate `schemaName` with strict regex in the operator before passing to SQL generator
  - Consider parameterized queries or at minimum escape single quotes in password values

- [ ] **Fix shell command injection in CLI** — `packages/cli/src/commands/env.ts`, `logs.ts`, `db.ts`
  - Replace string-interpolated shell commands with `execFileSync`/`spawn` using argument arrays

- [ ] **Restrict S3 CORS** — `packages/operator/src/reconcilers/storage.ts:76-82`
  - Change `AllowedOrigins` from `['*']` to `['https://${domain}']`
  - Restrict `AllowedMethods` to only what's needed (likely `GET` and `PUT`)

- [ ] **Add NetworkPolicies** — `manifests/`
  - Default-deny ingress/egress for app namespaces
  - Explicit allow rules for app-to-database, app-to-storage, ingress-to-app
  - Restrict operator egress to Keycloak, DB, S3 only

- [ ] **Upgrade @kubernetes/client-node** — `packages/operator/package.json`
  - Current v0.22.3 pulls in `request` with 5 known CVEs (SSRF, prototype pollution, DoS)
  - Upgrade to latest (breaking changes expected)

## Medium

- [ ] **Scope operator RBAC** — `manifests/helm/plattr-operator/templates/rbac.yaml`
  - Remove `delete` verb for namespaces
  - Consider namespace-scoped RoleBindings instead of ClusterRoleBinding

- [ ] **Configure PostgREST JWT auth** — `packages/operator/src/reconcilers/workload.ts:127-137`
  - Set `PGRST_JWT_SECRET` so the API isn't fully anonymous
  - Tie into Keycloak-issued JWTs

- [ ] **Scope IAM policies** — `packages/cdk/src/lib/plattr-cicd-stack.ts`
  - Restrict `eks:DescribeCluster` to specific cluster ARN
  - Restrict `sts:AssumeRole` resource from `*` to account-scoped ARN pattern

- [ ] **Add startup validation for required env vars** — `packages/operator/src/index.ts`
  - Fail fast if `BASE_DOMAIN`, `KEYCLOAK_ADMIN_PASSWORD`, `DB_SECRET_ARN` (or `DB_ADMIN_URL`) are not set
  - Don't silently fall back to `localhost` / `platform.company.dev` defaults in production

- [ ] **Encrypt internal Keycloak traffic** — `packages/cdk/src/lib/plattr-operator-stack.ts:365`
  - Disable `KC_HTTP_ENABLED` and use TLS for in-cluster communication

- [ ] **Add PostgREST security context** — `packages/operator/src/reconcilers/workload.ts:123-152`
  - PostgREST sidecar runs without explicit user — add `runAsNonRoot`, drop capabilities

- [ ] **Enable ECR image scanning** — `packages/cdk/src/lib/plattr-operator-stack.ts:108-117`
  - Add `imageScanningConfiguration: { scanOnPush: true }` to ECR repository

## Low

- [ ] **Add TTL bounds checking** — `packages/operator/src/reconcilers/preview.ts:32-42`
  - Cap preview environment TTL to a reasonable max (e.g., 30 days)

- [ ] **Replace Dagger inline YAML parser** — `packages/dagger/src/config.ts`
  - Use `js-yaml` instead of string manipulation for robustness

- [ ] **Add pre-commit secret scanning hook**
  - Use `detect-secrets` or similar to catch accidental credential commits

- [ ] **Add SECURITY.md** documenting the secrets management strategy

- [ ] **Inconsistent package manager** — `packages/dagger/yarn.lock` vs `package-lock.json` everywhere else
  - Standardize on npm
