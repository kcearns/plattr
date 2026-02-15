import { Registry, Gauge, Histogram, Counter } from 'prom-client';
import express from 'express';

export const registry = new Registry();

export const applicationPhaseGauge = new Gauge({
  name: 'plattr_application_phase',
  help: 'Current phase as number (0=Pending, 1=Provisioning, 2=Running, 3=Failed, 4=Terminating)',
  labelNames: ['app', 'environment'] as const,
  registers: [registry],
});

export const reconcileCounter = new Counter({
  name: 'plattr_reconcile_total',
  help: 'Total reconciliation attempts',
  labelNames: ['app', 'resource_type', 'result'] as const,
  registers: [registry],
});

export const provisioningDuration = new Histogram({
  name: 'plattr_provisioning_duration_seconds',
  help: 'Time to provision a resource',
  labelNames: ['app', 'resource_type'] as const,
  buckets: [1, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

export const previewEnvironmentsActive = new Gauge({
  name: 'plattr_preview_environments_active',
  help: 'Number of active preview environments',
  registers: [registry],
});

export function phaseToNumber(phase: string): number {
  switch (phase) {
    case 'Pending': return 0;
    case 'Provisioning': return 1;
    case 'Running': return 2;
    case 'Failed': return 3;
    case 'Terminating': return 4;
    default: return 0;
  }
}

export function startMetricsServer(port: number = 9090): void {
  const app = express();

  app.get('/metrics', async (_req, res) => {
    try {
      res.set('Content-Type', registry.contentType);
      res.end(await registry.metrics());
    } catch (err: any) {
      res.status(500).end(err.message);
    }
  });

  app.get('/healthz', (_req, res) => {
    res.status(200).send('ok');
  });

  app.listen(port, () => {
    console.log(`[METRICS] Metrics server listening on :${port}/metrics`);
  });
}
