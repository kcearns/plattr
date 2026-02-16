import { execSync } from 'child_process';
import { loadConfig } from '../lib/config';
import { killAllPids, clearState } from '../lib/state';

const NAMESPACE = 'plattr-local';
const CLUSTER_NAME = 'plattr';

/**
 * Get the app name from plattr.yaml, or null if not in a project directory.
 */
function getAppName(): string | null {
  try {
    const config = loadConfig();
    return config.name;
  } catch {
    return null;
  }
}

export function infraStatusCommand() {
  try {
    execSync(`kubectl cluster-info --context kind-${CLUSTER_NAME}`, { stdio: 'pipe' });
  } catch {
    console.log('No local Plattr cluster found. Run "plattr dev" to create one.');
    return;
  }

  console.log('Local infrastructure status:\n');
  execSync(`kubectl get pods -n ${NAMESPACE}`, { stdio: 'inherit' });
}

export function infraStopCommand() {
  try {
    execSync(`kubectl cluster-info --context kind-${CLUSTER_NAME}`, { stdio: 'pipe' });
  } catch {
    console.log('No local Plattr cluster found.');
    return;
  }

  // Kill all tracked PIDs and clear the PID file (keep env file)
  const appName = getAppName();
  if (appName) {
    killAllPids(appName);
  }

  // Scale down deployments to save resources
  execSync(`kubectl scale deployment --all --replicas=0 -n ${NAMESPACE}`, { stdio: 'inherit' });
  console.log('Infrastructure stopped. Data is preserved. Run "plattr dev" to restart.');
}

export function infraStartCommand() {
  try {
    execSync(`kubectl cluster-info --context kind-${CLUSTER_NAME}`, { stdio: 'pipe' });
  } catch {
    console.log('No local Plattr cluster found. Run "plattr dev" to create one.');
    return;
  }

  execSync(`kubectl scale deployment --all --replicas=1 -n ${NAMESPACE}`, { stdio: 'inherit' });
  console.log('Infrastructure starting...');
}

export function infraDestroyCommand() {
  // Kill all tracked PIDs and clear all state files
  const appName = getAppName();
  if (appName) {
    killAllPids(appName);
    clearState(appName);
  }

  try {
    execSync(`kind delete cluster --name ${CLUSTER_NAME}`, { stdio: 'inherit' });
  } catch {
    console.log('No local Plattr cluster found.');
  }

  // Stop and remove the local registry container
  try {
    execSync('docker rm -f plattr-registry', { stdio: 'pipe' });
  } catch {
    // Registry may not exist
  }

  console.log('Local cluster and registry deleted. All data removed. Run "plattr dev" to recreate.');
}

export function dbResetCommand() {
  try {
    execSync(`kubectl cluster-info --context kind-${CLUSTER_NAME}`, { stdio: 'pipe' });
  } catch {
    console.log('No local Plattr cluster found. Run "plattr dev" to create one.');
    return;
  }

  execSync(`kubectl delete pvc plattr-pgdata -n ${NAMESPACE}`, { stdio: 'inherit' });
  execSync(`kubectl rollout restart deployment/plattr-pg -n ${NAMESPACE}`, { stdio: 'inherit' });
  console.log('Database reset. Run "plattr dev" to recreate schemas.');
}
