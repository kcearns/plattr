import { dag, Service } from "@dagger.io/dagger"
import { generateInitSQL } from "../sql"

/**
 * Start a PostgreSQL 14 service with the app's schema and roles pre-initialized.
 *
 * - Database name: `plattr` (shared, same as production Aurora)
 * - Superuser: `plattr` / `localdev`
 * - Init SQL creates schema, app role, anon role, grants, default privileges
 */
export function startPostgres(appName: string, schemaName: string): Service {
  const initSQL = generateInitSQL(appName, schemaName, "localdev")

  return dag
    .container()
    .from("postgres:14-alpine")
    .withEnvVariable("POSTGRES_USER", "plattr")
    .withEnvVariable("POSTGRES_PASSWORD", "localdev")
    .withEnvVariable("POSTGRES_DB", "plattr")
    .withNewFile("/docker-entrypoint-initdb.d/01-init-app.sql", initSQL)
    .withExposedPort(5432)
    .asService()
}
