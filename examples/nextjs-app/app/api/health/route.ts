export async function GET() {
  const envVarNames = Object.keys(process.env)
    .filter((k) => /^(DATABASE_|DB_|S3_|POSTGREST_|AUTH_)/.test(k))
    .sort();

  return Response.json({
    app: "ok",
    timestamp: new Date().toISOString(),
    database: process.env.DATABASE_URL ? "connected" : "not configured",
    storage: process.env.S3_ENDPOINT ? "configured" : "not configured",
    postgrest: process.env.POSTGREST_URL ? "configured" : "not configured",
    envVars: envVarNames,
  });
}
