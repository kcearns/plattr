import { dag, Service } from "@dagger.io/dagger"

/**
 * Local Keycloak service for development.
 *
 * Starts Keycloak in dev mode (embedded H2 database, no HTTPS),
 * provisions a realm with an OIDC client and test user.
 */
export class LocalAuth {
  /**
   * Start Keycloak in dev mode with an embedded H2 database.
   * Data is ephemeral — clean state every time.
   */
  serve(appName: string): Service {
    return dag
      .container()
      .from("quay.io/keycloak/keycloak:26.0")
      .withEnvVariable("KEYCLOAK_ADMIN", "admin")
      .withEnvVariable("KEYCLOAK_ADMIN_PASSWORD", "admin")
      .withEnvVariable("KC_HEALTH_ENABLED", "true")
      .withEnvVariable("KC_METRICS_ENABLED", "true")
      .withExposedPort(8080)
      .withExec(["/opt/keycloak/bin/kc.sh", "start-dev"])
      .asService()
  }

  /**
   * Start Keycloak backed by a PostgreSQL service for persistent auth state.
   */
  serveWithPostgres(appName: string, dbService: Service): Service {
    const schema = `keycloak_${appName.replace(/-/g, "_")}`
    return dag
      .container()
      .from("quay.io/keycloak/keycloak:26.0")
      .withServiceBinding("db", dbService)
      .withEnvVariable("KC_DB", "postgres")
      .withEnvVariable(
        "KC_DB_URL",
        `jdbc:postgresql://db:5432/plattr?currentSchema=${schema}`,
      )
      .withEnvVariable("KC_DB_USERNAME", "plattr")
      .withEnvVariable("KC_DB_PASSWORD", "localdev")
      .withEnvVariable("KEYCLOAK_ADMIN", "admin")
      .withEnvVariable("KEYCLOAK_ADMIN_PASSWORD", "admin")
      .withEnvVariable("KC_HEALTH_ENABLED", "true")
      .withEnvVariable("KC_METRICS_ENABLED", "true")
      .withExposedPort(8080)
      .withExec(["/opt/keycloak/bin/kc.sh", "start-dev"])
      .asService()
  }

  /**
   * Provision a Keycloak realm, OIDC client, and test user
   * using the Keycloak Admin CLI (kcadm.sh) in a temporary container.
   */
  async provisionRealm(
    authService: Service,
    appName: string,
    redirectUri?: string,
  ): Promise<string> {
    const redirect = redirectUri || "http://localhost:3000/*"

    return dag
      .container()
      .from("quay.io/keycloak/keycloak:26.0")
      .withServiceBinding("auth", authService)
      // Authenticate to admin CLI
      .withExec([
        "/opt/keycloak/bin/kcadm.sh",
        "config",
        "credentials",
        "--server",
        "http://auth:8080",
        "--realm",
        "master",
        "--user",
        "admin",
        "--password",
        "admin",
      ])
      // Create realm
      .withExec([
        "/opt/keycloak/bin/kcadm.sh",
        "create",
        "realms",
        "-s",
        `realm=${appName}`,
        "-s",
        "enabled=true",
        "-s",
        "registrationAllowed=true",
      ])
      // Create OIDC client
      .withExec([
        "/opt/keycloak/bin/kcadm.sh",
        "create",
        "clients",
        "-r",
        appName,
        "-s",
        `clientId=${appName}-app`,
        "-s",
        "publicClient=true",
        "-s",
        "directAccessGrantsEnabled=true",
        "-s",
        `redirectUris=["${redirect}"]`,
        "-s",
        `webOrigins=["*"]`,
      ])
      // Create test user
      .withExec([
        "/opt/keycloak/bin/kcadm.sh",
        "create",
        "users",
        "-r",
        appName,
        "-s",
        "username=testuser",
        "-s",
        "email=test@example.com",
        "-s",
        "enabled=true",
        "-s",
        "emailVerified=true",
      ])
      // Set password
      .withExec([
        "/opt/keycloak/bin/kcadm.sh",
        "set-password",
        "-r",
        appName,
        "--username",
        "testuser",
        "--new-password",
        "testpassword",
      ])
      .stdout()
  }
}
