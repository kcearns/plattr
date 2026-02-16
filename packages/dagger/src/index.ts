/**
 * Plattr Dagger module for local development and builds.
 *
 * Reads a developer's plattr.yaml and starts a complete local environment
 * with PostgreSQL, MinIO, PostgREST, and the app — all inside the Dagger engine.
 */
import { dag, Container, Directory, Service, object, func } from "@dagger.io/dagger"
import { parseConfig } from "./config"
import { startPostgres } from "./services/postgres"
import { startMinio, createBuckets } from "./services/minio"
import { startPostgrest } from "./services/postgrest"
import { LocalAuth } from "./services/auth"

@object()
export class PlattrDev {
  /**
   * Health check — verify the module is operational.
   */
  @func()
  async ping(): Promise<string> {
    return "pong — plattr dagger module is operational"
  }

  /**
   * Detect the framework of a source directory.
   */
  @func()
  async detectFramework(source: Directory): Promise<string> {
    // Check for next.config.js / next.config.ts / next.config.mjs
    for (const configFile of ["next.config.js", "next.config.ts", "next.config.mjs"]) {
      const exists = await source
        .file(configFile)
        .contents()
        .then(
          () => true,
          () => false,
        )
      if (exists) return "nextjs"
    }

    // Fallback: check package.json for next dependency
    const hasNext = await source
      .file("package.json")
      .contents()
      .then(
        (content) => {
          const pkg = JSON.parse(content)
          const deps = { ...pkg.dependencies, ...pkg.devDependencies }
          return !!deps["next"]
        },
        () => false,
      )
    if (hasNext) return "nextjs"

    // Check for Gemfile + config.ru → rails
    const hasGemfile = await source.file("Gemfile").contents().then(() => true, () => false)
    const hasConfigRu = await source.file("config.ru").contents().then(() => true, () => false)
    if (hasGemfile && hasConfigRu) return "rails"

    // Check for Dockerfile → docker
    const hasDockerfile = await source.file("Dockerfile").contents().then(() => true, () => false)
    if (hasDockerfile) return "docker"

    // Default
    return "static"
  }

  /**
   * Start only the infrastructure services (PostgreSQL, MinIO, PostgREST,
   * Keycloak) without the application container.
   *
   * The app runs natively on the host with hot reload — this function
   * provides only the backing services with ports forwarded to localhost.
   *
   * Usage:
   *   dagger call infra --source=. up --ports=5432:5432,9000:9000,9001:9001,3001:3001,8080:8080
   */
  @func()
  async infra(source: Directory): Promise<Service> {
    const yamlContent = await source.file("plattr.yaml").contents()
    const config = parseConfig(yamlContent)

    const appName = config.name
    const schemaName = config.database?.schemaName || appName.replace(/-/g, "_")
    const appPort = config.local?.port || 3000

    const services: Array<{ name: string; service: Service }> = []
    const portForwards: Array<{ local: number; host: string; remote: number }> = []

    // --- PostgreSQL ---
    if (config.database?.enabled) {
      const pgService = startPostgres(appName, schemaName)
      services.push({ name: "db", service: pgService })
      portForwards.push({ local: 5432, host: "db", remote: 5432 })

      // --- PostgREST (requires PG) ---
      const postgrestService = startPostgrest(appName, schemaName, pgService)
      services.push({ name: "api", service: postgrestService })
      portForwards.push({ local: 3001, host: "api", remote: 3001 })
    }

    // --- MinIO ---
    if (config.storage?.enabled) {
      const minioService = startMinio()
      services.push({ name: "storage", service: minioService })
      portForwards.push({ local: 9000, host: "storage", remote: 9000 })
      portForwards.push({ local: 9001, host: "storage", remote: 9001 })

      const buckets = config.storage.buckets || []
      if (buckets.length > 0) {
        await createBuckets(minioService, buckets, appName)
      }
    }

    // --- Keycloak (Auth) ---
    if (config.auth?.enabled) {
      const auth = new LocalAuth()
      const authService = auth.serve(appName)
      services.push({ name: "auth", service: authService })
      portForwards.push({ local: 8080, host: "auth", remote: 8080 })

      await auth.provisionRealm(authService, appName, `http://localhost:${appPort}/*`)
    }

    // Build a lightweight proxy container that binds all services and
    // forwards their ports to localhost via socat.
    let ctr = dag
      .container()
      .from("alpine:3.19")
      .withExec(["apk", "add", "--no-cache", "socat", "postgresql-client"])

    // Bind all infrastructure services
    for (const { name, service } of services) {
      ctr = ctr.withServiceBinding(name, service)
    }

    // Expose all infrastructure ports
    for (const pf of portForwards) {
      ctr = ctr.withExposedPort(pf.local)
    }

    // Build startup script: wait for PG, then run socat forwarders
    const socatLines = portForwards.map(
      (pf) => `socat TCP-LISTEN:${pf.local},fork,reuseaddr TCP:${pf.host}:${pf.remote} &`,
    )

    const waitForPg = config.database?.enabled
      ? [
          `echo "Waiting for PostgreSQL..."`,
          `for i in $(seq 1 30); do`,
          `  pg_isready -h db -p 5432 -U plattr && break`,
          `  sleep 1`,
          `done`,
          `echo "PostgreSQL is ready."`,
        ]
      : []

    const script = [...waitForPg, ...socatLines, `echo "Infrastructure services ready."`, `sleep infinity`].join("\n")

    return ctr.asService({ args: ["sh", "-c", script] })
  }

  /**
   * Start a complete local development environment.
   *
   * Reads plattr.yaml, starts infrastructure services (PostgreSQL, MinIO,
   * PostgREST), and runs the framework-specific dev server with all services
   * bound and env vars set.
   */
  @func()
  async dev(source: Directory, port: number = 3000): Promise<Service> {
    const yamlContent = await source.file("plattr.yaml").contents()
    const config = parseConfig(yamlContent)

    const appName = config.name
    const schemaName = config.database?.schemaName || appName.replace(/-/g, "_")
    const framework = config.framework || (await this.detectFramework(source))
    const appPort = config.local?.port || port

    const envVars: Record<string, string> = {}
    const services: Array<{ name: string; service: Service }> = []

    // --- PostgreSQL ---
    if (config.database?.enabled) {
      const pgService = startPostgres(appName, schemaName)
      services.push({ name: "db", service: pgService })

      envVars.DATABASE_URL = `postgresql://${appName}_app:localdev@db:5432/plattr?search_path=${schemaName}`
      envVars.DB_HOST = "db"
      envVars.DB_PORT = "5432"
      envVars.DB_NAME = "plattr"
      envVars.DB_USER = `${appName}_app`
      envVars.DB_PASSWORD = "localdev"
      envVars.DB_SCHEMA = schemaName

      // --- PostgREST (requires PG) ---
      const postgrestService = startPostgrest(appName, schemaName, pgService)
      services.push({ name: "api", service: postgrestService })
      envVars.POSTGREST_URL = "http://api:3001"
    }

    // --- MinIO ---
    if (config.storage?.enabled) {
      const minioService = startMinio()
      services.push({ name: "storage", service: minioService })

      envVars.S3_ENDPOINT = "http://storage:9000"
      envVars.S3_ACCESS_KEY = "minioadmin"
      envVars.S3_SECRET_KEY = "minioadmin"
      envVars.S3_REGION = "us-east-1"

      const buckets = config.storage.buckets || []
      for (const bucket of buckets) {
        const envKey = `S3_BUCKET_${bucket.name.toUpperCase().replace(/-/g, "_")}`
        envVars[envKey] = `${appName}-${bucket.name}`
      }

      if (buckets.length > 0) {
        await createBuckets(minioService, buckets, appName)
      }
    }

    // --- Keycloak (Auth) ---
    if (config.auth?.enabled) {
      const auth = new LocalAuth()
      const authService = auth.serve(appName)
      services.push({ name: "auth", service: authService })

      // Provision realm + OIDC client + test user
      await auth.provisionRealm(authService, appName, `http://localhost:${appPort}/*`)

      envVars.AUTH_ISSUER_URL = `http://auth:8080/realms/${appName}`
      envVars.AUTH_CLIENT_ID = `${appName}-app`
      envVars.AUTH_ADMIN_URL = "http://auth:8080/admin"
    }

    // Apply local.env overrides
    if (config.local?.env) {
      for (const [key, value] of Object.entries(config.local.env)) {
        envVars[key] = value
      }
    }

    return this.startDevServer(source, framework, envVars, services, appPort)
  }

  /**
   * Start an isolated preview environment for a pull request.
   *
   * Similar to dev() but every resource name includes the PR number, so
   * multiple previews and the main dev environment can coexist without collision.
   *
   * Usage:
   *   dagger call preview --source=. --pr-number=42 up --ports=3100:3100,5433:5432,9002:9000
   */
  @func()
  async preview(source: Directory, prNumber: number, port: number = 3100): Promise<Service> {
    const yamlContent = await source.file("plattr.yaml").contents()
    const config = parseConfig(yamlContent)

    const appName = config.name
    const previewName = `${appName}-pr${prNumber}`
    const previewSchema = `preview_${appName.replace(/-/g, "_")}_pr${prNumber}`
    const framework = config.framework || (await this.detectFramework(source))
    const appPort = port

    const envVars: Record<string, string> = {
      PLATFORM_ENVIRONMENT: "preview",
      PLATFORM_PR_NUMBER: String(prNumber),
    }
    const services: Array<{ name: string; service: Service }> = []

    // --- PostgreSQL (isolated schema for this PR) ---
    if (config.database?.enabled) {
      const pgService = startPostgres(previewName, previewSchema)
      services.push({ name: "db", service: pgService })

      envVars.DATABASE_URL = `postgresql://${previewName}_app:localdev@db:5432/plattr?search_path=${previewSchema}`
      envVars.DB_HOST = "db"
      envVars.DB_PORT = "5432"
      envVars.DB_NAME = "plattr"
      envVars.DB_USER = `${previewName}_app`
      envVars.DB_PASSWORD = "localdev"
      envVars.DB_SCHEMA = previewSchema

      // --- PostgREST (requires PG) ---
      const postgrestService = startPostgrest(previewName, previewSchema, pgService)
      services.push({ name: "api", service: postgrestService })
      envVars.POSTGREST_URL = "http://api:3001"
    }

    // --- MinIO (isolated bucket names for this PR) ---
    if (config.storage?.enabled) {
      const minioService = startMinio()
      services.push({ name: "storage", service: minioService })

      envVars.S3_ENDPOINT = "http://storage:9000"
      envVars.S3_ACCESS_KEY = "minioadmin"
      envVars.S3_SECRET_KEY = "minioadmin"
      envVars.S3_REGION = "us-east-1"

      const buckets = config.storage.buckets || []
      for (const bucket of buckets) {
        const envKey = `S3_BUCKET_${bucket.name.toUpperCase().replace(/-/g, "_")}`
        envVars[envKey] = `${previewName}-${bucket.name}`
      }

      if (buckets.length > 0) {
        await createBuckets(minioService, buckets, previewName)
      }
    }

    // --- Keycloak (Auth) ---
    if (config.auth?.enabled) {
      const auth = new LocalAuth()
      const authService = auth.serve(previewName)
      services.push({ name: "auth", service: authService })

      await auth.provisionRealm(authService, previewName, `http://localhost:${appPort}/*`)

      envVars.AUTH_ISSUER_URL = `http://auth:8080/realms/${previewName}`
      envVars.AUTH_CLIENT_ID = `${previewName}-app`
      envVars.AUTH_ADMIN_URL = "http://auth:8080/admin"
    }

    // Apply local.env overrides
    if (config.local?.env) {
      for (const [key, value] of Object.entries(config.local.env)) {
        envVars[key] = value
      }
    }

    return this.startDevServer(source, framework, envVars, services, appPort)
  }

  /**
   * Run database migrations.
   */
  @func()
  async migrate(source: Directory, engine: string = "sql"): Promise<string> {
    const yamlContent = await source.file("plattr.yaml").contents()
    const config = parseConfig(yamlContent)

    const appName = config.name
    const schemaName = config.database?.schemaName || appName.replace(/-/g, "_")
    const pgService = startPostgres(appName, schemaName)
    const dbUrl = `postgresql://${appName}_app:localdev@db:5432/plattr?search_path=${schemaName}`

    let ctr = dag
      .container()
      .from("node:20-slim")
      .withServiceBinding("db", pgService)
      .withMountedDirectory("/app", source)
      .withWorkdir("/app")
      .withEnvVariable("DATABASE_URL", dbUrl)

    switch (engine) {
      case "prisma":
        ctr = ctr.withExec(["npx", "prisma", "migrate", "deploy"])
        break
      case "knex":
        ctr = ctr.withExec(["npx", "knex", "migrate:latest"])
        break
      default:
        ctr = ctr.withExec([
          "sh",
          "-c",
          `for f in migrations/*.sql; do [ -f "$f" ] && psql "$DATABASE_URL" -f "$f" && echo "Applied $f"; done; echo "Migrations complete"`,
        ])
    }

    return ctr.stdout()
  }

  /**
   * Open an interactive psql shell connected to the app's database.
   */
  @func()
  async dbShell(source: Directory): Promise<Container> {
    const yamlContent = await source.file("plattr.yaml").contents()
    const config = parseConfig(yamlContent)

    const appName = config.name
    const schemaName = config.database?.schemaName || appName.replace(/-/g, "_")
    const pgService = startPostgres(appName, schemaName)

    return dag
      .container()
      .from("postgres:14-alpine")
      .withServiceBinding("db", pgService)
      .withEnvVariable("PGPASSWORD", "localdev")
      .withDefaultTerminalCmd([
        "psql",
        "-h", "db",
        "-U", `${appName}_app`,
        "-d", "plattr",
      ])
  }

  /**
   * Run a SQL seed file against the app's database.
   */
  @func()
  async seed(source: Directory, seedFile: string = "seed.sql"): Promise<string> {
    const yamlContent = await source.file("plattr.yaml").contents()
    const config = parseConfig(yamlContent)

    const appName = config.name
    const schemaName = config.database?.schemaName || appName.replace(/-/g, "_")
    const pgService = startPostgres(appName, schemaName)

    return dag
      .container()
      .from("postgres:14-alpine")
      .withServiceBinding("db", pgService)
      .withMountedDirectory("/app", source)
      .withWorkdir("/app")
      .withEnvVariable("PGPASSWORD", "localdev")
      .withExec(["psql", "-h", "db", "-U", `${appName}_app`, "-d", "plattr", "-f", seedFile])
      .stdout()
  }

  /**
   * Build a production-optimized container image.
   */
  @func()
  async build(source: Directory, framework?: string): Promise<Container> {
    const fw = framework || (await this.detectFramework(source))

    switch (fw) {
      case "nextjs":
        return this.buildNextjs(source)
      case "rails":
        return this.buildRails(source)
      case "static":
        return this.buildStatic(source)
      case "docker":
        return this.buildDocker(source)
      default:
        throw new Error(`Unsupported framework: ${fw}`)
    }
  }

  /**
   * Run the app's test suite against real infrastructure.
   */
  @func()
  async test(source: Directory): Promise<string> {
    const yamlContent = await source.file("plattr.yaml").contents()
    const config = parseConfig(yamlContent)

    const appName = config.name
    const schemaName = config.database?.schemaName || appName.replace(/-/g, "_")
    const framework = config.framework || (await this.detectFramework(source))

    const envVars: Record<string, string> = {}
    const services: Array<{ name: string; service: Service }> = []

    // Start PostgreSQL if needed
    if (config.database?.enabled) {
      const pgService = startPostgres(appName, schemaName)
      services.push({ name: "db", service: pgService })

      envVars.DATABASE_URL = `postgresql://${appName}_app:localdev@db:5432/plattr?search_path=${schemaName}`
      envVars.DB_HOST = "db"
      envVars.DB_PORT = "5432"
      envVars.DB_NAME = "plattr"
      envVars.DB_USER = `${appName}_app`
      envVars.DB_PASSWORD = "localdev"
      envVars.DB_SCHEMA = schemaName
    }

    // Start MinIO if needed
    if (config.storage?.enabled) {
      const minioService = startMinio()
      services.push({ name: "storage", service: minioService })

      envVars.S3_ENDPOINT = "http://storage:9000"
      envVars.S3_ACCESS_KEY = "minioadmin"
      envVars.S3_SECRET_KEY = "minioadmin"
      envVars.S3_REGION = "us-east-1"

      const buckets = config.storage.buckets || []
      for (const bucket of buckets) {
        const envKey = `S3_BUCKET_${bucket.name.toUpperCase().replace(/-/g, "_")}`
        envVars[envKey] = `${appName}-${bucket.name}`
      }

      if (buckets.length > 0) {
        await createBuckets(minioService, buckets, appName)
      }
    }

    // Static sites have no tests
    if (framework === "static") {
      return "No tests for static sites"
    }

    // Build the test container
    let ctr: Container

    switch (framework) {
      case "nextjs": {
        ctr = dag
          .container()
          .from("node:20-slim")
          .withMountedDirectory("/app", source)
          .withWorkdir("/app")
          .withExec(["npm", "ci"])

        // Check if a test script exists
        const pkgContent = await source.file("package.json").contents()
        const pkg = JSON.parse(pkgContent)
        if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
          ctr = ctr.withExec(["npm", "test"])
        } else {
          return "No test script found in package.json — skipping"
        }
        break
      }

      case "rails":
        ctr = dag
          .container()
          .from("ruby:3.3-slim")
          .withExec(["apt-get", "update"])
          .withExec(["apt-get", "install", "-y", "build-essential", "libpq-dev"])
          .withMountedDirectory("/app", source)
          .withWorkdir("/app")
          .withExec(["bundle", "install"])
          .withExec(["bundle", "exec", "rails", "test"])
        break

      case "docker": {
        // Check if package.json exists for npm test
        const hasPkg = await source.file("package.json").contents().then(() => true, () => false)
        if (!hasPkg) {
          return "No package.json found — skipping tests"
        }
        ctr = dag
          .container()
          .from("node:20-slim")
          .withMountedDirectory("/app", source)
          .withWorkdir("/app")
          .withExec(["npm", "ci"])
          .withExec(["npm", "test"])
        break
      }

      default:
        return `No tests for framework: ${framework}`
    }

    // Bind services and inject env vars
    for (const { name, service } of services) {
      ctr = ctr.withServiceBinding(name, service)
    }
    for (const [key, value] of Object.entries(envVars)) {
      ctr = ctr.withEnvVariable(key, value)
    }

    return ctr.stdout()
  }

  /**
   * Build the production image and push it to a container registry.
   */
  @func()
  async buildAndPush(
    source: Directory,
    appName: string,
    environment: string,
    registryUrl: string,
  ): Promise<string> {
    const container = await this.build(source)
    const timestamp = Date.now()
    const tag = `${registryUrl}/${appName}:${environment}-${timestamp}`
    await container.publish(tag)
    return tag
  }

  private buildNextjs(source: Directory): Container {
    // Multi-stage: install + build, then copy standalone output
    const builder = dag
      .container()
      .from("node:20-slim")
      .withMountedDirectory("/app", source)
      .withWorkdir("/app")
      .withExec(["npm", "ci"])
      .withEnvVariable("NEXT_TELEMETRY_DISABLED", "1")
      .withExec(["npm", "run", "build"])

    // Production stage: only standalone server + static assets
    let prod = dag
      .container()
      .from("node:20-slim")
      .withDirectory("/app", builder.directory("/app/.next/standalone"))
      .withDirectory("/app/.next/static", builder.directory("/app/.next/static"))
      .withDirectory("/app/public", source.directory("public"), { exclude: [] })

    return prod
      .withWorkdir("/app")
      .withExposedPort(3000)
      .withEntrypoint(["node", "server.js"])
  }

  private buildRails(source: Directory): Container {
    return dag
      .container()
      .from("ruby:3.3-slim")
      .withExec(["apt-get", "update"])
      .withExec(["apt-get", "install", "-y", "build-essential", "libpq-dev"])
      .withMountedDirectory("/app", source)
      .withWorkdir("/app")
      .withExec(["bundle", "config", "set", "deployment", "true"])
      .withExec(["bundle", "install"])
      .withEnvVariable("RAILS_ENV", "production")
      .withExec(["bundle", "exec", "rails", "assets:precompile"])
      .withExposedPort(3000)
      .withEntrypoint(["bundle", "exec", "rails", "server", "-b", "0.0.0.0"])
  }

  private buildStatic(source: Directory): Container {
    return dag
      .container()
      .from("nginx:alpine")
      .withDirectory("/usr/share/nginx/html", source)
      .withExposedPort(80)
  }

  private buildDocker(source: Directory): Container {
    return dag.container().build(source)
  }

  /**
   * Create the framework-specific dev server container with all services
   * bound and env vars injected, returned as a Dagger Service.
   *
   * Infrastructure service ports are forwarded via socat so that
   * `up --ports=5432:5432,...` exposes them on localhost.
   */
  private startDevServer(
    source: Directory,
    framework: string,
    envVars: Record<string, string>,
    services: Array<{ name: string; service: Service }>,
    port: number,
  ): Service {
    // Determine which infrastructure ports to forward through the app container
    const portForwards: Array<{ local: number; host: string; remote: number }> = []
    for (const { name } of services) {
      switch (name) {
        case "db":
          portForwards.push({ local: 5432, host: name, remote: 5432 })
          break
        case "storage":
          portForwards.push({ local: 9000, host: name, remote: 9000 })
          portForwards.push({ local: 9001, host: name, remote: 9001 })
          break
        case "api":
          portForwards.push({ local: 3001, host: name, remote: 3001 })
          break
        case "auth":
          portForwards.push({ local: 8080, host: name, remote: 8080 })
          break
      }
    }

    const needsSocat = portForwards.length > 0 && framework !== "docker"

    let ctr: Container
    let appCmd: string[]

    switch (framework) {
      case "nextjs":
        ctr = dag
          .container()
          .from("node:20-slim")
        if (needsSocat) {
          ctr = ctr
            .withExec(["apt-get", "update"])
            .withExec(["apt-get", "install", "-y", "--no-install-recommends", "socat"])
        }
        ctr = ctr
          .withMountedDirectory("/app", source)
          .withWorkdir("/app")
          .withExec(["npm", "install"])
        appCmd = ["npx", "next", "dev", "-H", "0.0.0.0", "-p", String(port)]
        break

      case "rails":
        ctr = dag
          .container()
          .from("ruby:3.3-slim")
          .withExec(["apt-get", "update"])
          .withExec(["apt-get", "install", "-y", "build-essential", "libpq-dev", "nodejs", ...(needsSocat ? ["socat"] : [])])
          .withMountedDirectory("/app", source)
          .withWorkdir("/app")
          .withExec(["bundle", "install"])
        appCmd = ["rails", "server", "-b", "0.0.0.0", "-p", String(port)]
        break

      case "static":
        ctr = dag
          .container()
          .from("node:20-slim")
        if (needsSocat) {
          ctr = ctr
            .withExec(["apt-get", "update"])
            .withExec(["apt-get", "install", "-y", "--no-install-recommends", "socat"])
        }
        ctr = ctr
          .withExec(["npm", "install", "-g", "serve"])
          .withMountedDirectory("/app", source)
          .withWorkdir("/app")
        appCmd = ["serve", "-s", ".", "-l", String(port)]
        break

      case "docker":
        ctr = source.dockerBuild()
        appCmd = []
        break

      default:
        throw new Error(`Unsupported framework: ${framework}`)
    }

    // Expose the app port and all infrastructure ports
    ctr = ctr.withExposedPort(port)
    for (const pf of portForwards) {
      ctr = ctr.withExposedPort(pf.local)
    }

    // Bind all infrastructure services
    for (const { name, service } of services) {
      ctr = ctr.withServiceBinding(name, service)
    }

    // Inject all env vars
    for (const [key, value] of Object.entries(envVars)) {
      ctr = ctr.withEnvVariable(key, value)
    }

    // Build a startup script that runs socat port forwarders + the app
    if (needsSocat && portForwards.length > 0) {
      const socatLines = portForwards.map(
        (pf) => `socat TCP-LISTEN:${pf.local},fork,reuseaddr TCP:${pf.host}:${pf.remote} &`,
      )
      const script = [...socatLines, `exec ${appCmd.join(" ")}`].join("\n")
      return ctr.asService({ args: ["sh", "-c", script] })
    }

    // Docker framework or no port forwards — just start directly
    if (framework === "docker") {
      return ctr.asService()
    }
    return ctr.asService({ args: appCmd })
  }
}
