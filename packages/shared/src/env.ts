export function buildDatabaseEnv(
  appName: string,
  schemaName: string,
  host: string,
  password: string,
): Record<string, string> {
  return {
    DATABASE_URL: `postgresql://${appName}_app:${password}@${host}:5432/plattr?search_path=${schemaName}`,
    DB_HOST: host,
    DB_PORT: '5432',
    DB_NAME: 'plattr',
    DB_USER: `${appName}_app`,
    DB_PASSWORD: password,
    DB_SCHEMA: schemaName,
  };
}

export function buildStorageEnv(
  endpoint: string,
  region: string,
  buckets: Array<{ name: string }>,
  appName: string,
  accessKey?: string,
  secretKey?: string,
): Record<string, string> {
  const env: Record<string, string> = {
    S3_ENDPOINT: endpoint,
    S3_REGION: region,
  };

  if (accessKey) {
    env.S3_ACCESS_KEY = accessKey;
  }
  if (secretKey) {
    env.S3_SECRET_KEY = secretKey;
  }

  for (const bucket of buckets) {
    const envKey = `S3_BUCKET_${bucket.name.toUpperCase().replace(/-/g, '_')}`;
    env[envKey] = `${appName}-${bucket.name}`;
  }

  return env;
}
