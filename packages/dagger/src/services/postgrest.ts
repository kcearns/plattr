import { dag, Service } from "@dagger.io/dagger"

const ETC_PASSWD = [
  "root:x:0:0:root:/root:/bin/sh",
  "postgrest:x:1000:1000:postgrest:/home/postgrest:/bin/sh",
].join("\n") + "\n"

const ETC_GROUP = [
  "root:x:0:",
  "postgrest:x:1000:",
].join("\n") + "\n"

/**
 * Start a PostgREST service that auto-generates a REST API from the database schema.
 *
 * Connects to the PostgreSQL service via service binding (hostname: db).
 * Exposes port 3001.
 */
export function startPostgrest(
  appName: string,
  schemaName: string,
  pgService: Service,
): Service {
  return dag
    .container()
    .from("postgrest/postgrest:latest")
    .withNewFile("/etc/passwd", ETC_PASSWD)
    .withNewFile("/etc/group", ETC_GROUP)
    .withServiceBinding("db", pgService)
    .withEnvVariable("PGRST_DB_URI", `postgresql://${appName}_app:localdev@db:5432/plattr`)
    .withEnvVariable("PGRST_DB_SCHEMAS", schemaName)
    .withEnvVariable("PGRST_DB_ANON_ROLE", `${appName}_anon`)
    .withEnvVariable("PGRST_SERVER_PORT", "3001")
    .withExposedPort(3001)
    .asService()
}
