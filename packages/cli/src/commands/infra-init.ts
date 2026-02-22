import prompts from 'prompts';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import * as path from 'path';

const AWS_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'ca-central-1', 'ca-west-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1',
  'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2', 'ap-south-1',
  'sa-east-1',
];

const CDK_JSON_PATH = path.resolve(__dirname, '../../../cdk/cdk.json');

type Ctx = Record<string, unknown>;

function loadExistingContext(): Ctx {
  if (!existsSync(CDK_JSON_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(CDK_JSON_PATH, 'utf-8'));
    return parsed.context ?? {};
  } catch {
    return {};
  }
}

/** Return a string from context, or fallback */
function ctx(existing: Ctx, key: string, fallback?: string): string | undefined {
  const v = existing[key];
  if (v !== undefined && v !== null) return String(v);
  return fallback;
}

/** Return a number from context, or fallback */
function ctxNum(existing: Ctx, key: string, fallback: number): number {
  const v = existing[key];
  if (v !== undefined && v !== null) {
    const n = Number(v);
    if (!isNaN(n)) return n;
  }
  return fallback;
}

/** Return a boolean from context (stored as 'true'/'false'), or fallback */
function ctxBool(existing: Ctx, key: string, fallback: boolean): boolean {
  const v = existing[key];
  if (v === 'true' || v === true) return true;
  if (v === 'false' || v === false) return false;
  return fallback;
}

export async function infraInitCommand() {
  const prev = loadExistingContext();
  const hasExisting = Object.keys(prev).length > 0;

  if (hasExisting) {
    console.log('Found existing cdk.json — values shown as defaults. Press Enter to keep.');
  }

  // Determine env type initial selection from existing target
  const prevEnvType = prev.target === 'prod' ? 1 : 0;

  // Step 1: Environment type
  const { envType } = await prompts({
    type: 'select',
    name: 'envType',
    message: 'Environment type?',
    choices: [
      { title: 'Non-prod (staging/dev)', value: 'nonprod' },
      { title: 'Production', value: 'prod' },
    ],
    initial: prevEnvType,
  });

  if (!envType) { console.log('Cancelled.'); return; }

  // Step 2: Common inputs
  const prevRegionIdx = AWS_REGIONS.indexOf(ctx(prev, 'region', 'ca-central-1')!);
  const common = await prompts([
    {
      type: 'text',
      name: 'account',
      message: 'AWS Account ID?',
      initial: ctx(prev, 'account'),
      validate: (v: string) => /^\d{12}$/.test(v) || 'Must be exactly 12 digits',
    },
    {
      type: 'select',
      name: 'region',
      message: 'AWS Region?',
      choices: AWS_REGIONS.map(r => ({ title: r, value: r })),
      initial: prevRegionIdx >= 0 ? prevRegionIdx : AWS_REGIONS.indexOf('ca-central-1'),
    },
    {
      type: 'text',
      name: 'baseDomain',
      message: 'Base domain? (e.g. platform.company.dev)',
      initial: ctx(prev, 'baseDomain'),
      validate: (v: string) => v.includes('.') || 'Must be a valid domain',
    },
    {
      type: 'text',
      name: 'hostedZoneId',
      message: 'Route 53 Hosted Zone ID?',
      initial: ctx(prev, 'hostedZoneId'),
      validate: (v: string) => /^Z[A-Z0-9]+$/.test(v) || 'Must start with Z followed by alphanumeric characters',
    },
    {
      type: 'text',
      name: 'githubOrg',
      message: 'GitHub organization name?',
      initial: ctx(prev, 'githubOrg'),
      validate: (v: string) => v.length > 0 || 'Required',
    },
    {
      type: 'text',
      name: 'githubRepoFilter',
      message: 'GitHub repo filter? (optional, press Enter to skip)',
      initial: ctx(prev, 'githubRepoFilter', ''),
    },
  ]);

  if (!common.account) { console.log('Cancelled.'); return; }

  // Step 3: Add-ons
  const addons = await prompts([
    { type: 'confirm', name: 'installCertManager', message: 'Install cert-manager?', initial: ctxBool(prev, 'installCertManager', true) },
    { type: 'confirm', name: 'installExternalDns', message: 'Install external-dns?', initial: ctxBool(prev, 'installExternalDns', true) },
    { type: 'confirm', name: 'installIngressNginx', message: 'Install ingress-nginx?', initial: ctxBool(prev, 'installIngressNginx', true) },
    { type: 'confirm', name: 'installKeycloak', message: 'Install Keycloak?', initial: ctxBool(prev, 'installKeycloak', true) },
  ]);

  const result = envType === 'nonprod'
    ? await collectNonprod(prev, common, addons)
    : await collectProd(prev, common, addons);

  if (!result) return;

  // Write cdk.json
  const cdkJson = {
    app: 'npx ts-node bin/plattr.ts',
    context: result.context,
  };

  writeFileSync(CDK_JSON_PATH, JSON.stringify(cdkJson, null, 2) + '\n');
  console.log(`\nWrote ${path.relative(process.cwd(), CDK_JSON_PATH)}`);

  const stacks = result.stacks.join(' ');
  console.log('\nNext steps:');
  console.log('  cd packages/cdk');
  console.log('  npm install');
  console.log(`  npx cdk bootstrap aws://${common.account}/${common.region}`);
  console.log(`  npx cdk deploy ${stacks}`);
}

interface InitResult {
  context: Ctx;
  stacks: string[];
}

async function collectNonprod(
  prev: Ctx,
  common: Record<string, string>,
  addons: Record<string, boolean>,
): Promise<InitResult | null> {
  const prevInfraMode = prev.useInfraStack === 'true' ? 0
    : (prev.kubectlRoleArn ? 1 : 0);

  const { infraMode } = await prompts({
    type: 'select',
    name: 'infraMode',
    message: 'Infrastructure mode?',
    choices: [
      { title: 'CDK-managed (new VPC + EKS + Aurora)', value: 'cdk' },
      { title: 'Existing infrastructure', value: 'existing' },
    ],
    initial: prevInfraMode,
  });

  if (!infraMode) { console.log('Cancelled.'); return null; }

  const base = buildCommonContext('nonprod', common, addons);

  if (infraMode === 'cdk') {
    const cluster = await prompts([
      { type: 'text', name: 'eksClusterName', message: 'EKS cluster name?', initial: ctx(prev, 'eksClusterName', 'plattr-nonprod') },
      {
        type: 'text',
        name: 'availabilityZones',
        message: 'Availability zones? (comma-separated, e.g. us-east-1b,us-east-1c — leave blank for auto)',
        initial: ctx(prev, 'availabilityZones', ''),
      },
      { type: 'text', name: 'nodeInstanceType', message: 'Node instance type?', initial: ctx(prev, 'nodeInstanceType', 't3.large') },
      { type: 'number', name: 'nodeMinSize', message: 'Node min count?', initial: ctxNum(prev, 'nodeMinSize', 2) },
      { type: 'number', name: 'nodeMaxSize', message: 'Node max count?', initial: ctxNum(prev, 'nodeMaxSize', 4) },
      { type: 'number', name: 'nodeDesiredSize', message: 'Node desired count?', initial: ctxNum(prev, 'nodeDesiredSize', 2) },
      { type: 'number', name: 'auroraMinCapacity', message: 'Aurora min ACU?', initial: ctxNum(prev, 'auroraMinCapacity', 0.5), float: true },
      { type: 'number', name: 'auroraMaxCapacity', message: 'Aurora max ACU?', initial: ctxNum(prev, 'auroraMaxCapacity', 4) },
    ]);

    if (cluster.eksClusterName === undefined) { console.log('Cancelled.'); return null; }

    return {
      context: {
        ...base,
        useInfraStack: 'true',
        eksClusterName: cluster.eksClusterName,
        ...(cluster.availabilityZones ? { availabilityZones: cluster.availabilityZones } : {}),
        nodeInstanceType: cluster.nodeInstanceType,
        nodeMinSize: String(cluster.nodeMinSize),
        nodeMaxSize: String(cluster.nodeMaxSize),
        nodeDesiredSize: String(cluster.nodeDesiredSize),
        auroraMinCapacity: String(cluster.auroraMinCapacity),
        auroraMaxCapacity: String(cluster.auroraMaxCapacity),
      },
      stacks: ['PlattrInfraStack', 'PlattrOperatorStack', 'PlattrCicdStack'],
    };
  }

  // Existing infrastructure
  const existing = await prompts([
    {
      type: 'text',
      name: 'eksClusterName',
      message: 'EKS cluster name?',
      initial: ctx(prev, 'eksClusterName'),
      validate: (v: string) => v.length > 0 || 'Required',
    },
    {
      type: 'text',
      name: 'kubectlRoleArn',
      message: 'kubectl Role ARN?',
      initial: ctx(prev, 'kubectlRoleArn'),
      validate: (v: string) => v.startsWith('arn:aws:iam::') || v.startsWith('arn:aws:iam:') || 'Must be a valid IAM ARN',
    },
    {
      type: 'text',
      name: 'oidcProviderArn',
      message: 'OIDC Provider ARN?',
      initial: ctx(prev, 'oidcProviderArn'),
      validate: (v: string) => v.startsWith('arn:aws:iam::') || v.startsWith('arn:aws:iam:') || 'Must be a valid IAM ARN',
    },
    {
      type: 'text',
      name: 'auroraEndpoint',
      message: 'Aurora cluster endpoint?',
      initial: ctx(prev, 'auroraEndpoint'),
      validate: (v: string) => v.includes('.') || 'Must be a valid endpoint',
    },
    {
      type: 'text',
      name: 'auroraSgId',
      message: 'Aurora Security Group ID?',
      initial: ctx(prev, 'auroraSgId'),
      validate: (v: string) => v.startsWith('sg-') || 'Must start with sg-',
    },
  ]);

  if (existing.eksClusterName === undefined) { console.log('Cancelled.'); return null; }

  return {
    context: {
      ...base,
      eksClusterName: existing.eksClusterName,
      kubectlRoleArn: existing.kubectlRoleArn,
      oidcProviderArn: existing.oidcProviderArn,
      auroraEndpoint: existing.auroraEndpoint,
      auroraSgId: existing.auroraSgId,
    },
    stacks: ['PlattrOperatorStack', 'PlattrCicdStack'],
  };
}

async function collectProd(
  prev: Ctx,
  common: Record<string, string>,
  addons: Record<string, boolean>,
): Promise<InitResult | null> {
  const cluster = await prompts([
    { type: 'text', name: 'eksClusterName', message: 'EKS cluster name?', initial: ctx(prev, 'eksClusterName', 'plattr-prod') },
    {
      type: 'text',
      name: 'availabilityZones',
      message: 'Availability zones? (comma-separated, e.g. us-east-1b,us-east-1c — leave blank for auto)',
      initial: ctx(prev, 'availabilityZones', ''),
    },
    { type: 'text', name: 'nodeInstanceType', message: 'Node instance type?', initial: ctx(prev, 'nodeInstanceType', 't3.xlarge') },
    { type: 'number', name: 'nodeMinSize', message: 'Node min count?', initial: ctxNum(prev, 'nodeMinSize', 2) },
    { type: 'number', name: 'nodeMaxSize', message: 'Node max count?', initial: ctxNum(prev, 'nodeMaxSize', 6) },
    { type: 'number', name: 'nodeDesiredSize', message: 'Node desired count?', initial: ctxNum(prev, 'nodeDesiredSize', 3) },
    { type: 'number', name: 'auroraMinCapacity', message: 'Aurora min ACU?', initial: ctxNum(prev, 'auroraMinCapacity', 1) },
    { type: 'number', name: 'auroraMaxCapacity', message: 'Aurora max ACU?', initial: ctxNum(prev, 'auroraMaxCapacity', 8) },
    { type: 'text', name: 'opensearchInstanceType', message: 'OpenSearch instance type?', initial: ctx(prev, 'opensearchInstanceType', 't3.medium.search') },
    { type: 'number', name: 'opensearchDataNodeCount', message: 'OpenSearch data node count?', initial: ctxNum(prev, 'opensearchDataNodeCount', 2) },
    { type: 'text', name: 'nonprodAccountId', message: 'Non-prod Account ID? (for cross-account ECR pull, optional)', initial: ctx(prev, 'nonprodAccountId', '') },
    { type: 'text', name: 'prodAccountId', message: 'Prod Account ID? (for CI/CD cross-account, optional)', initial: ctx(prev, 'prodAccountId', '') },
  ]);

  if (cluster.eksClusterName === undefined) { console.log('Cancelled.'); return null; }

  const base = buildCommonContext('prod', common, addons);

  return {
    context: {
      ...base,
      eksClusterName: cluster.eksClusterName,
      ...(cluster.availabilityZones ? { availabilityZones: cluster.availabilityZones } : {}),
      nodeInstanceType: cluster.nodeInstanceType,
      nodeMinSize: String(cluster.nodeMinSize),
      nodeMaxSize: String(cluster.nodeMaxSize),
      nodeDesiredSize: String(cluster.nodeDesiredSize),
      auroraMinCapacity: String(cluster.auroraMinCapacity),
      auroraMaxCapacity: String(cluster.auroraMaxCapacity),
      opensearchInstanceType: cluster.opensearchInstanceType,
      opensearchDataNodeCount: String(cluster.opensearchDataNodeCount),
      ...(cluster.nonprodAccountId ? { nonprodAccountId: cluster.nonprodAccountId } : {}),
      ...(cluster.prodAccountId ? { prodAccountId: cluster.prodAccountId } : {}),
    },
    stacks: ['PlattrProdInfraStack', 'PlattrProdOperatorStack', 'PlattrCicdStack'],
  };
}

function buildCommonContext(
  target: string,
  common: Record<string, string>,
  addons: Record<string, boolean>,
): Ctx {
  return {
    target,
    account: common.account,
    region: common.region,
    baseDomain: common.baseDomain,
    hostedZoneId: common.hostedZoneId,
    githubOrg: common.githubOrg,
    ...(common.githubRepoFilter ? { githubRepoFilter: common.githubRepoFilter } : {}),
    installCertManager: String(addons.installCertManager),
    installExternalDns: String(addons.installExternalDns),
    installIngressNginx: String(addons.installIngressNginx),
    installKeycloak: String(addons.installKeycloak),
  };
}
