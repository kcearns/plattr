#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PlattrInfraStack } from '../src/lib/plattr-infra-stack';
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
// Mode: useInfraStack
// =============================================================================
// Set -c useInfraStack=true to provision VPC + EKS + Aurora via CDK and
// automatically wire them into the operator stack (no manual -c args needed).
// When false (default), the operator stack expects manual -c context args
// pointing to existing infrastructure.
// =============================================================================

const useInfraStack = app.node.tryGetContext('useInfraStack') === 'true';

if (useInfraStack) {
  // CDK-managed infrastructure — PlattrInfraStack provisions VPC, EKS, Aurora
  const infra = new PlattrInfraStack(app, 'PlattrInfraStack', {
    env,
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
  // Existing infrastructure — provide values via -c context args
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
});

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  return isNaN(n) ? undefined : n;
}
