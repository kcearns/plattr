#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PlattrOperatorStack } from '../src/lib/plattr-operator-stack';
import { PlattrCicdStack } from '../src/lib/plattr-cicd-stack';

const app = new cdk.App();

// =============================================================================
// CONFIGURATION — Customize these values for your environment
// =============================================================================
//
// In practice, you would reference your existing EKS cluster using one of:
//   1. cdk.Fn.importValue('MyEksClusterName') — if exported from another stack
//   2. SSM Parameter Store lookup
//   3. Direct cluster attributes
//
// Below is a template showing how to import an existing cluster.
// Replace the placeholder values with your actual infrastructure references.
// =============================================================================

const ACCOUNT = app.node.tryGetContext('account') || process.env.CDK_DEFAULT_ACCOUNT || 'YOUR_ACCOUNT_ID';
const REGION = app.node.tryGetContext('region') || process.env.CDK_DEFAULT_REGION || 'ca-central-1';

const env = { account: ACCOUNT, region: REGION };

// EKS cluster attributes — these come from your existing EKS CDK stack or Terraform output.
const EKS_CLUSTER_NAME = app.node.tryGetContext('eksClusterName') || 'my-eks-cluster';
const KUBECTL_ROLE_ARN = app.node.tryGetContext('kubectlRoleArn') || `arn:aws:iam::${ACCOUNT}:role/my-eks-kubectl-role`;
const OIDC_PROVIDER_ARN = app.node.tryGetContext('oidcProviderArn') || `arn:aws:iam::${ACCOUNT}:oidc-provider/oidc.eks.${REGION}.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE`;

// =============================================================================
// Stacks
// =============================================================================

new PlattrOperatorStack(app, 'PlattrOperatorStack', {
  env,
  // EKS cluster attributes — the stack imports the cluster internally
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
  // Set to false if these are already installed in your cluster
  installCertManager: app.node.tryGetContext('installCertManager') !== 'false',
  installExternalDns: app.node.tryGetContext('installExternalDns') !== 'false',
  installIngressNginx: app.node.tryGetContext('installIngressNginx') !== 'false',
  installKeycloak: app.node.tryGetContext('installKeycloak') !== 'false',
});

new PlattrCicdStack(app, 'PlattrCicdStack', {
  env,
  githubOrg: app.node.tryGetContext('githubOrg') || 'your-org',
  githubRepoFilter: app.node.tryGetContext('githubRepoFilter'),
});
