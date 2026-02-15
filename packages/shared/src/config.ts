import yaml from 'js-yaml';
import { PlattrConfig } from './types';

const VALID_FRAMEWORKS: ReadonlyArray<string> = ['nextjs', 'rails', 'static', 'docker'];
const VALID_MIGRATION_ENGINES: ReadonlyArray<string> = ['prisma', 'knex', 'raw'];
const NAME_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function parsePlattrConfig(yamlString: string): PlattrConfig {
  const raw = yaml.load(yamlString);

  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid plattr.yaml: must be a YAML object');
  }

  const data = raw as Record<string, unknown>;

  if (!data.name || typeof data.name !== 'string') {
    throw new Error('Invalid plattr.yaml: "name" is required and must be a string');
  }

  if (!NAME_REGEX.test(data.name)) {
    throw new Error('Invalid plattr.yaml: "name" must be lowercase alphanumeric with hyphens');
  }

  if (data.framework !== undefined) {
    if (typeof data.framework !== 'string' || !VALID_FRAMEWORKS.includes(data.framework)) {
      throw new Error(`Invalid plattr.yaml: "framework" must be one of: ${VALID_FRAMEWORKS.join(', ')}`);
    }
  }

  const database = data.database as Record<string, unknown> | undefined;
  if (database !== undefined) {
    if (typeof database.enabled !== 'boolean') {
      throw new Error('Invalid plattr.yaml: "database.enabled" must be a boolean');
    }
  }

  const storage = data.storage as Record<string, unknown> | undefined;
  if (storage !== undefined) {
    const buckets = (storage.buckets as Array<Record<string, unknown>>) || [];
    for (const bucket of buckets) {
      if (!bucket.name || typeof bucket.name !== 'string') {
        throw new Error('Invalid plattr.yaml: each storage bucket must have a "name"');
      }
      if (!NAME_REGEX.test(bucket.name)) {
        throw new Error(`Invalid plattr.yaml: bucket name "${bucket.name}" must be lowercase alphanumeric with hyphens`);
      }
    }
  }

  if (database) {
    const migrations = database.migrations as Record<string, unknown> | undefined;
    if (migrations?.engine !== undefined) {
      if (typeof migrations.engine !== 'string' || !VALID_MIGRATION_ENGINES.includes(migrations.engine)) {
        throw new Error(`Invalid plattr.yaml: "database.migrations.engine" must be one of: ${VALID_MIGRATION_ENGINES.join(', ')}`);
      }
    }
  }

  const config: PlattrConfig = {
    name: data.name,
  };

  if (data.framework) {
    config.framework = data.framework as PlattrConfig['framework'];
  }

  if (database) {
    config.database = {
      enabled: database.enabled as boolean,
      schemaName: (database.schemaName as string) || data.name.replace(/-/g, '_'),
    };
  }

  if (storage) {
    config.storage = {
      enabled: storage.enabled as boolean,
      buckets: ((storage.buckets as Array<Record<string, unknown>>) || []).map(b => ({
        name: b.name as string,
        public: (b.public as boolean) || false,
      })),
    };
  }

  if (data.auth) {
    const auth = data.auth as Record<string, unknown>;
    config.auth = {
      enabled: auth.enabled as boolean,
      providers: auth.providers as string[] | undefined,
    };
  }

  {
    const scaling = data.scaling as Record<string, unknown> | undefined;
    config.scaling = {
      min: (scaling?.min as number) ?? 2,
      max: (scaling?.max as number) ?? 20,
      targetCPU: (scaling?.targetCPU as number) ?? 70,
    };
  }

  if (data.local) {
    const local = data.local as Record<string, unknown>;
    config.local = {
      port: (local.port as number) ?? 3000,
      env: local.env as Record<string, string> | undefined,
    };
  }

  return config;
}
