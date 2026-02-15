import * as k8s from '@kubernetes/client-node';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const coreApi = kc.makeApiClient(k8s.CoreV1Api);

const KEYCLOAK_ADMIN_URL = process.env.KEYCLOAK_ADMIN_URL || 'http://keycloak-http.plattr-system:80';
const KEYCLOAK_ADMIN_USER = process.env.KEYCLOAK_ADMIN_USER || 'admin';
const KEYCLOAK_ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD || 'admin';

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAdminToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const response = await fetch(
    `${KEYCLOAK_ADMIN_URL}/realms/master/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: KEYCLOAK_ADMIN_USER,
        password: KEYCLOAK_ADMIN_PASSWORD,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Keycloak token request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  cachedToken = data.access_token;
  // Refresh 10s before expiry
  tokenExpiresAt = Date.now() + (data.expires_in - 10) * 1000;
  return cachedToken;
}

export async function reconcileAuth(
  appName: string,
  providers: string[],
  namespace: string,
  domain: string,
): Promise<{ ready: boolean; error?: string }> {
  try {
    const token = await getAdminToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    // --- Check/create realm ---
    const realmRes = await fetch(`${KEYCLOAK_ADMIN_URL}/admin/realms/${appName}`, { headers });

    if (realmRes.status === 404) {
      console.log(`  [AUTH] Creating realm "${appName}"...`);
      const createRealmRes = await fetch(`${KEYCLOAK_ADMIN_URL}/admin/realms`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          realm: appName,
          enabled: true,
          registrationAllowed: true,
          loginWithEmailAllowed: true,
        }),
      });

      if (!createRealmRes.ok && createRealmRes.status !== 409) {
        const body = await createRealmRes.text();
        throw new Error(`Failed to create realm: ${createRealmRes.status} ${body}`);
      }
      console.log(`  [AUTH] Realm "${appName}" created`);
    } else if (!realmRes.ok) {
      throw new Error(`Failed to check realm: ${realmRes.status}`);
    } else {
      console.log(`  [AUTH] Realm "${appName}" already exists`);
    }

    // --- Check/create OIDC client ---
    const clientId = `${appName}-app`;
    const clientsRes = await fetch(
      `${KEYCLOAK_ADMIN_URL}/admin/realms/${appName}/clients?clientId=${clientId}`,
      { headers },
    );

    if (!clientsRes.ok) {
      throw new Error(`Failed to list clients: ${clientsRes.status}`);
    }

    const clients = await clientsRes.json() as Array<{ id: string }>;

    if (clients.length === 0) {
      console.log(`  [AUTH] Creating OIDC client "${clientId}"...`);
      const createClientRes = await fetch(
        `${KEYCLOAK_ADMIN_URL}/admin/realms/${appName}/clients`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            clientId,
            publicClient: true,
            directAccessGrantsEnabled: true,
            redirectUris: [`https://${domain}/*`],
            webOrigins: ['*'],
          }),
        },
      );

      if (!createClientRes.ok && createClientRes.status !== 409) {
        const body = await createClientRes.text();
        throw new Error(`Failed to create client: ${createClientRes.status} ${body}`);
      }
      console.log(`  [AUTH] OIDC client "${clientId}" created`);
    } else {
      console.log(`  [AUTH] OIDC client "${clientId}" already exists`);
    }

    // --- Identity providers (log if secrets unavailable) ---
    for (const provider of providers) {
      console.log(`  [AUTH] Identity provider "${provider}" requested — platform-level OAuth secrets required for configuration`);
    }

    // --- Create auth ConfigMap ---
    const baseDomain = process.env.BASE_DOMAIN || 'platform.company.dev';
    const configMapName = `${appName}-auth`;
    const configMap: k8s.V1ConfigMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: configMapName,
        namespace,
        labels: {
          'platform.internal/app': appName,
          'platform.internal/managed-by': 'plattr-operator',
        },
      },
      data: {
        AUTH_ISSUER_URL: `https://auth.${baseDomain}/realms/${appName}`,
        AUTH_CLIENT_ID: clientId,
      },
    };

    try {
      await coreApi.createNamespacedConfigMap(namespace, configMap);
      console.log(`  [AUTH] ConfigMap "${configMapName}" created`);
    } catch (err: any) {
      if (err?.response?.statusCode === 409 || err?.statusCode === 409 || err?.code === 409) {
        await coreApi.replaceNamespacedConfigMap(configMapName, namespace, configMap);
        console.log(`  [AUTH] ConfigMap "${configMapName}" updated`);
      } else {
        throw err;
      }
    }

    return { ready: true };
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  [AUTH] Error: ${message}`);
    return { ready: false, error: message };
  }
}

export async function cleanupAuth(appName: string, namespace: string): Promise<void> {
  // --- Delete Keycloak realm ---
  try {
    const token = await getAdminToken();
    const headers = {
      Authorization: `Bearer ${token}`,
    };

    const res = await fetch(`${KEYCLOAK_ADMIN_URL}/admin/realms/${appName}`, {
      method: 'DELETE',
      headers,
    });

    if (res.ok || res.status === 404) {
      console.log(`  [AUTH] Realm "${appName}" deleted`);
    } else {
      console.error(`  [AUTH] Failed to delete realm: ${res.status}`);
    }
  } catch (err: any) {
    console.error(`  [AUTH] Realm cleanup error: ${err.message}`);
  }

  // --- Delete auth ConfigMap ---
  const configMapName = `${appName}-auth`;
  try {
    await coreApi.deleteNamespacedConfigMap(configMapName, namespace);
    console.log(`  [AUTH] ConfigMap "${configMapName}" deleted`);
  } catch (err: any) {
    if (err?.response?.statusCode === 404 || err?.statusCode === 404 || err?.code === 404) {
      console.log(`  [AUTH] ConfigMap "${configMapName}" already gone`);
    } else {
      console.error(`  [AUTH] ConfigMap cleanup error: ${err.message}`);
    }
  }
}
