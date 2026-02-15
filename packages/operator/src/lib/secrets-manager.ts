import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

let cachedDbUrl: string | null = null;

export async function getDbAdminUrl(): Promise<string> {
  // In dev, use the env var directly
  if (process.env.DB_ADMIN_URL) {
    return process.env.DB_ADMIN_URL;
  }

  // In production, read from Secrets Manager
  if (cachedDbUrl) return cachedDbUrl;

  const secretArn = process.env.DB_SECRET_ARN;
  if (!secretArn) {
    throw new Error('Either DB_ADMIN_URL or DB_SECRET_ARN must be set');
  }

  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION || 'ca-central-1',
  });

  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );

  const secret = JSON.parse(response.SecretString!);
  cachedDbUrl = `postgresql://${secret.username}:${secret.password}@${secret.host}:${secret.port}/${secret.dbname}`;

  return cachedDbUrl;
}
