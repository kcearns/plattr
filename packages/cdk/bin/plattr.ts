#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PlattrInfraStack } from '../src/lib/plattr-infra-stack';
import { PlattrProdInfraStack } from '../src/lib/plattr-prod-infra-stack';
import { PlattrOperatorStack } from '../src/lib/plattr-operator-stack';
import { PlattrCicdStack } from '../src/lib/plattr-cicd-stack';

const app = new cdk.App();

// =============================================================================
// CONFIGURATION — Customize these values for your environment
// =============================================================================

const ACCOUNT = app.node.tryGetContext('account') || process.env.CDK_DEFAULT_ACCOUNT || 'YOUR_ACCOUNT_ID';
const REGION = app.node.tryGetContext('region') || process.env.CDK_DEFAULT_REGION || 'ca-central-1';

const env = { account: ACCOUNT, region: REGION };

// =============================================================================
// Mode: target
// =============================================================================
// Set -c target=prod to deploy production infrastructure in a separate account.
// Production uses AWS managed services (ElastiCache, OpenSearch) instead of
// containerized equivalents.
//
// Set -c useInfraStack=true to provision non-prod VPC + EKS + Aurora via CDK.
// When false (default), the operator stack expects manual -c context args
// pointing to existing infrastructure.
// =============================================================================

const target = app.node.tryGetContext('target');
const useInfraStack = app.node.tryGetContext('useInfraStack') === 'true';
const azString: string | undefined = app.node.tryGetContext('availabilityZones');
const availabilityZones = azString ? azString.split(',').map(s => s.trim()) : undefined;

if (target === 'prod') {
  // ─── Production Account ─────────────────────────────────────────────
  // Separate EKS cluster with AWS managed services (Aurora, ElastiCache, OpenSearch)
  const prodInfra = new PlattrProdInfraStack(app, 'PlattrProdInfraStack', {
    env,
    availabilityZones,
    clusterName: app.node.tryGetContext('eksClusterName') || 'plattr-prod',
    nodeInstanceType: app.node.tryGetContext('nodeInstanceType') || undefined,
    nodeMinSize: numberOrUndefined(app.node.tryGetContext('nodeMinSize')),
    nodeMaxSize: numberOrUndefined(app.node.tryGetContext('nodeMaxSize')),
    nodeDesiredSize: numberOrUndefined(app.node.tryGetContext('nodeDesiredSize')),
    auroraMinCapacity: numberOrUndefined(app.node.tryGetContext('auroraMinCapacity')),
    auroraMaxCapacity: numberOrUndefined(app.node.tryGetContext('auroraMaxCapacity')),
    opensearchInstanceType: app.node.tryGetContext('opensearchInstanceType') || undefined,
    opensearchDataNodeCount: numberOrUndefined(app.node.tryGetContext('opensearchDataNodeCount')),
    nonprodAccountId: app.node.tryGetContext('nonprodAccountId') || undefined,
  });

  new PlattrOperatorStack(app, 'PlattrProdOperatorStack', {
    env,
    eksClusterName: prodInfra.cluster.clusterName,
    kubectlRoleArn: prodInfra.cluster.kubectlRole!.roleArn,
    oidcProviderArn: prodInfra.cluster.openIdConnectProvider.openIdConnectProviderArn,
    auroraClusterEndpoint: prodInfra.auroraCluster.clusterEndpoint.hostname,
    auroraSecurityGroupId: prodInfra.auroraSecurityGroup.securityGroupId,
    baseDomain:
      app.node.tryGetContext('baseDomain') || 'prod.company.dev',
    hostedZoneId:
      app.node.tryGetContext('hostedZoneId') || 'Z0123456789',
    installCertManager: app.node.tryGetContext('installCertManager') !== 'false',
    installExternalDns: app.node.tryGetContext('installExternalDns') !== 'false',
    installIngressNginx: app.node.tryGetContext('installIngressNginx') !== 'false',
    installKeycloak: app.node.tryGetContext('installKeycloak') !== 'false',
    redisEndpoint: prodInfra.redisEndpoint,
    opensearchEndpoint: prodInfra.opensearchEndpoint,
    prodMode: true,
  });
} else if (useInfraStack) {
  // ─── Non-Prod: CDK-managed infrastructure ───────────────────────────
  const infra = new PlattrInfraStack(app, 'PlattrInfraStack', {
    env,
    availabilityZones,
    clusterName: app.node.tryGetContext('eksClusterName') || 'plattr-nonprod',
    nodeInstanceType: app.node.tryGetContext('nodeInstanceType') || undefined,
    nodeMinSize: numberOrUndefined(app.node.tryGetContext('nodeMinSize')),
    nodeMaxSize: numberOrUndefined(app.node.tryGetContext('nodeMaxSize')),
    nodeDesiredSize: numberOrUndefined(app.node.tryGetContext('nodeDesiredSize')),
    auroraMinCapacity: numberOrUndefined(app.node.tryGetContext('auroraMinCapacity')),
    auroraMaxCapacity: numberOrUndefined(app.node.tryGetContext('auroraMaxCapacity')),
  });

  new PlattrOperatorStack(app, 'PlattrOperatorStack', {
    env,
    eksClusterName: infra.cluster.clusterName,
    kubectlRoleArn: infra.cluster.kubectlRole!.roleArn,
    oidcProviderArn: infra.cluster.openIdConnectProvider.openIdConnectProviderArn,
    auroraClusterEndpoint: infra.auroraCluster.clusterEndpoint.hostname,
    auroraSecurityGroupId: infra.auroraSecurityGroup.securityGroupId,
    baseDomain:
      app.node.tryGetContext('baseDomain') || 'platform.company.dev',
    hostedZoneId:
      app.node.tryGetContext('hostedZoneId') || 'Z0123456789',
    installCertManager: app.node.tryGetContext('installCertManager') !== 'false',
    installExternalDns: app.node.tryGetContext('installExternalDns') !== 'false',
    installIngressNginx: app.node.tryGetContext('installIngressNginx') !== 'false',
    installKeycloak: app.node.tryGetContext('installKeycloak') !== 'false',
  });
} else {
  // ─── Non-Prod: Existing infrastructure ──────────────────────────────
  const EKS_CLUSTER_NAME = app.node.tryGetContext('eksClusterName') || 'my-eks-cluster';
  const KUBECTL_ROLE_ARN = app.node.tryGetContext('kubectlRoleArn') || `arn:aws:iam::${ACCOUNT}:role/my-eks-kubectl-role`;
  const OIDC_PROVIDER_ARN = app.node.tryGetContext('oidcProviderArn') || `arn:aws:iam::${ACCOUNT}:oidc-provider/oidc.eks.${REGION}.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE`;

  new PlattrOperatorStack(app, 'PlattrOperatorStack', {
    env,
    eksClusterName: EKS_CLUSTER_NAME,
    kubectlRoleArn: KUBECTL_ROLE_ARN,
    oidcProviderArn: OIDC_PROVIDER_ARN,
    auroraClusterEndpoint:
      app.node.tryGetContext('auroraEndpoint') ||
      'your-aurora-cluster.xxxxx.ca-central-1.rds.amazonaws.com',
    auroraSecurityGroupId:
      app.node.tryGetContext('auroraSgId') || 'sg-xxxxx',
    baseDomain:
      app.node.tryGetContext('baseDomain') || 'platform.company.dev',
    hostedZoneId:
      app.node.tryGetContext('hostedZoneId') || 'Z0123456789',
    installCertManager: app.node.tryGetContext('installCertManager') !== 'false',
    installExternalDns: app.node.tryGetContext('installExternalDns') !== 'false',
    installIngressNginx: app.node.tryGetContext('installIngressNginx') !== 'false',
    installKeycloak: app.node.tryGetContext('installKeycloak') !== 'false',
  });
}

new PlattrCicdStack(app, 'PlattrCicdStack', {
  env,
  githubOrg: app.node.tryGetContext('githubOrg') || 'your-org',
  githubRepoFilter: app.node.tryGetContext('githubRepoFilter'),
  prodAccountId: app.node.tryGetContext('prodAccountId') || undefined,
});

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  return isNaN(n) ? undefined : n;
}
