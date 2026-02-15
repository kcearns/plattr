import * as k8s from '@kubernetes/client-node';
import { hostname } from 'os';

const LEASE_NAME = 'plattr-operator-leader';
const LEASE_NAMESPACE = process.env.OPERATOR_NAMESPACE || 'default';
const LEASE_DURATION_SECONDS = 15;
const RENEW_INTERVAL_MS = 5000;
const LEADER_ELECTION_ENABLED = process.env.LEADER_ELECTION === 'true';

let isLeader = false;
let identity: string;

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const coordinationApi = kc.makeApiClient(k8s.CoordinationV1Api);

export function getIsLeader(): boolean {
  if (!LEADER_ELECTION_ENABLED) return true;
  return isLeader;
}

export function startLeaderElection(operatorId?: string): void {
  identity = operatorId || `plattr-operator-${hostname()}-${process.pid}`;
  console.log(`[LEADER] Identity: ${identity}`);
  console.log(`[LEADER] Lease: ${LEASE_NAME} in ${LEASE_NAMESPACE}`);

  const loop = async () => {
    try {
      await tryAcquireOrRenew();
    } catch (err: any) {
      console.error(`[LEADER] Election error: ${err.message}`);
      if (isLeader) {
        isLeader = false;
        console.log('[LEADER] Lost leadership (error)');
      }
    }
  };

  loop();
  setInterval(loop, RENEW_INTERVAL_MS);
}

async function tryAcquireOrRenew(): Promise<void> {
  let lease: any;

  try {
    const res = await coordinationApi.readNamespacedLease(LEASE_NAME, LEASE_NAMESPACE) as any;
    lease = res.body || res;
  } catch (err: any) {
    const code = err?.response?.statusCode || err?.statusCode || err?.code;
    if (code === 404) {
      // Lease doesn't exist — create it
      await coordinationApi.createNamespacedLease(LEASE_NAMESPACE, {
        metadata: {
          name: LEASE_NAME,
          namespace: LEASE_NAMESPACE,
        },
        spec: {
          holderIdentity: identity,
          leaseDurationSeconds: LEASE_DURATION_SECONDS,
          acquireTime: new k8s.V1MicroTime(new Date()),
          renewTime: new k8s.V1MicroTime(new Date()),
        },
      });
      if (!isLeader) {
        isLeader = true;
        console.log('[LEADER] Acquired leadership (new lease)');
      }
      return;
    }
    throw err;
  }

  const holder = lease.spec?.holderIdentity;
  const renewTime = lease.spec?.renewTime ? new Date(lease.spec.renewTime) : new Date(0);
  const now = new Date();
  const expiry = new Date(renewTime.getTime() + LEASE_DURATION_SECONDS * 1000);

  if (holder === identity) {
    // We hold the lease — renew it
    lease.spec.renewTime = new k8s.V1MicroTime(now);
    await coordinationApi.replaceNamespacedLease(LEASE_NAME, LEASE_NAMESPACE, lease);
    if (!isLeader) {
      isLeader = true;
      console.log('[LEADER] Acquired leadership (renewed)');
    }
  } else if (expiry < now) {
    // Lease expired — acquire it
    lease.spec.holderIdentity = identity;
    lease.spec.acquireTime = new k8s.V1MicroTime(now);
    lease.spec.renewTime = new k8s.V1MicroTime(now);
    await coordinationApi.replaceNamespacedLease(LEASE_NAME, LEASE_NAMESPACE, lease);
    isLeader = true;
    console.log(`[LEADER] Acquired leadership (expired from ${holder})`);
  } else {
    // Someone else holds the lease and it hasn't expired
    if (isLeader) {
      isLeader = false;
      console.log(`[LEADER] Lost leadership to ${holder}`);
    }
  }
}
