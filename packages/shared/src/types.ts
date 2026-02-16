export interface PlattrConfig {
  name: string;
  framework?: 'nextjs' | 'rails' | 'static' | 'docker';
  database?: {
    enabled: boolean;
    schemaName?: string;
  };
  storage?: {
    enabled: boolean;
    buckets: Array<{
      name: string;
      public: boolean;
    }>;
  };
  auth?: {
    enabled: boolean;
    providers?: string[];
  };
  redis?: {
    enabled: boolean;
  };
  search?: {
    enabled: boolean;
  };
  scaling?: {
    min?: number;
    max?: number;
    targetCPU?: number;
  };
  local?: {
    port?: number;
    env?: Record<string, string>;
  };
}

export interface ApplicationSpec {
  repository: string;
  framework: string;
  environment: string;
  imageRef?: string;
  database?: { enabled: boolean; schemaName?: string };
  storage?: { enabled: boolean; buckets: Array<{ name: string; public: boolean }> };
  auth?: { enabled: boolean; providers?: string[] };
  redis?: { enabled: boolean };
  search?: { enabled: boolean };
  scaling?: { min: number; max: number; targetCPU: number };
  domain?: string;
}

export interface PreviewEnvironmentSpec {
  applicationRef: string;
  pullRequest: number;
  branch: string;
  ttl?: string;
}
