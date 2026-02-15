/**
 * Resolve the kubectl context and namespace for a given environment.
 *
 * The mapping is:
 *   staging    → namespace: staging
 *   uat        → namespace: uat
 *   production → namespace: production (default)
 *   preview    → namespace: preview-{appName}-pr-{prNumber}
 */
export function resolveEnv(appName: string, env: string, prNumber?: number): {
  namespace: string;
  resourceName: string;
} {
  if (env === 'preview') {
    if (!prNumber) throw new Error('--pr is required for preview environment');
    return {
      namespace: `preview-${appName}-pr-${prNumber}`,
      resourceName: `${appName}-pr${prNumber}`,
    };
  }
  return {
    namespace: env === 'production' ? 'production' : env,
    resourceName: appName,
  };
}
