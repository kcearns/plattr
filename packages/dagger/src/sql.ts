/**
 * Inline SQL generator — duplicated from @plattr/shared because the Dagger engine
 * can't import workspace packages. Must stay in sync with packages/shared/src/sql.ts.
 */

export function generateInitSQL(appName: string, schemaName: string, password: string = "localdev"): string {
  return `-- Schema
CREATE SCHEMA IF NOT EXISTS "${schemaName}";

-- App role
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${appName}_app') THEN
    CREATE ROLE "${appName}_app" LOGIN PASSWORD '${password}';
  END IF;
END
$$;

-- Anon role (for PostgREST)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${appName}_anon') THEN
    CREATE ROLE "${appName}_anon" NOLOGIN;
  END IF;
END
$$;

-- Grant anon role to app role (required for PostgREST role switching)
GRANT "${appName}_anon" TO "${appName}_app";

-- Grants
GRANT ALL ON SCHEMA "${schemaName}" TO "${appName}_app";
GRANT USAGE ON SCHEMA "${schemaName}" TO "${appName}_anon";

-- Default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA "${schemaName}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${appName}_app";
ALTER DEFAULT PRIVILEGES IN SCHEMA "${schemaName}" GRANT SELECT ON TABLES TO "${appName}_anon";

-- Search path
ALTER ROLE "${appName}_app" SET search_path TO "${schemaName}";`
}
