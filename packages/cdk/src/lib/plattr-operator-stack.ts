import * as cdk from 'aws-cdk-lib';
import * as eks from '@aws-cdk/aws-eks-v2-alpha';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { KubectlV33Layer } from '@aws-cdk/lambda-layer-kubectl-v33';
import { Construct } from 'constructs';
import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import * as path from 'path';

export interface PlattrOperatorStackProps extends cdk.StackProps {
  /** Name of your existing EKS cluster */
  eksClusterName: string;
  /** ARN of the IAM role with kubectl access to the cluster */
  kubectlRoleArn: string;
  /** ARN of the OIDC provider for the EKS cluster (for IRSA) */
  oidcProviderArn: string;
  /** Aurora cluster endpoint (e.g. aurora-cluster.xxxxx.ca-central-1.rds.amazonaws.com) */
  auroraClusterEndpoint: string;
  /** Security group ID of the Aurora cluster (for network access) */
  auroraSecurityGroupId: string;
  /** ECR repository URI for the operator image */
  operatorEcrRepoUri: string;
  /** Base domain for app ingresses (e.g. platform.company.dev) */
  baseDomain: string;
  /** Route 53 hosted zone ID for the base domain */
  hostedZoneId: string;
  /** Install cert-manager Helm chart (default: true) */
  installCertManager?: boolean;
  /** Install external-dns Helm chart (default: true) */
  installExternalDns?: boolean;
  /** Install Traefik ingress controller Helm chart (default: true) */
  installTraefik?: boolean;
  /** Install Keycloak Helm chart for managed auth (default: true) */
  installKeycloak?: boolean;
  /** ElastiCache Redis endpoint (empty = container mode) */
  redisEndpoint?: string;
  /** OpenSearch Service domain endpoint (empty = container mode) */
  opensearchEndpoint?: string;
  /** Production mode — only creates production namespace (default: false) */
  prodMode?: boolean;
}

export class PlattrOperatorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PlattrOperatorStackProps) {
    super(scope, id, props);

    const operatorNamespace = 'plattr-system';

    // -------------------------------------------------------
    // Import existing EKS cluster
    // -------------------------------------------------------
    const oidcProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'ImportedOidc',
      props.oidcProviderArn,
    );

    const kubectlRole = iam.Role.fromRoleArn(this, 'ImportedKubectlRole', props.kubectlRoleArn);

    const cluster = eks.Cluster.fromClusterAttributes(this, 'ImportedCluster', {
      clusterName: props.eksClusterName,
      openIdConnectProvider: oidcProvider,
      kubectlProvider: new eks.KubectlProvider(this, 'KubectlProvider', {
        cluster: eks.Cluster.fromClusterAttributes(this, 'ClusterForKubectl', {
          clusterName: props.eksClusterName,
        }),
        kubectlLayer: new KubectlV33Layer(this, 'KubectlLayer'),
        role: kubectlRole,
      }),
    });

    // -------------------------------------------------------
    // 1. Plattr namespace
    // -------------------------------------------------------
    cluster.addManifest('PlattrNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: operatorNamespace,
        labels: {
          'platform.internal/managed-by': 'plattr-cdk',
        },
      },
    });

    // -------------------------------------------------------
    // 2. CRDs — load from manifests/crds/
    // -------------------------------------------------------
    const crdsDir = path.resolve(__dirname, '../../../../manifests/crds');

    const appCrd = yaml.load(
      readFileSync(path.join(crdsDir, 'application.yaml'), 'utf-8'),
    ) as Record<string, unknown>;
    cluster.addManifest('CRD-Application', appCrd);

    const previewCrd = yaml.load(
      readFileSync(path.join(crdsDir, 'preview-environment.yaml'), 'utf-8'),
    ) as Record<string, unknown>;
    cluster.addManifest('CRD-PreviewEnvironment', previewCrd);

    // -------------------------------------------------------
    // 3. DB admin secret in Secrets Manager
    // -------------------------------------------------------
    const dbSecret = new secretsmanager.Secret(this, 'DbAdminSecret', {
      secretName: 'plattr/db-admin',
      description: 'Aurora admin credentials for the Plattr operator',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          host: props.auroraClusterEndpoint,
          port: 5432,
          username: 'plattr_admin',
          dbname: 'plattr',
        }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    // -------------------------------------------------------
    // 4. IRSA — IAM role for the operator ServiceAccount
    // -------------------------------------------------------
    // Extract the OIDC issuer URL from the provider ARN.
    // Use CfnJson so the condition keys resolve at deploy time —
    // this is required when the OIDC ARN is a cross-stack token.
    const oidcIssuer = cdk.Fn.select(
      1,
      cdk.Fn.split('oidc-provider/', props.oidcProviderArn),
    );

    const irsaCondition = new cdk.CfnJson(this, 'IrsaCondition', {
      value: {
        [`${oidcIssuer}:sub`]:
          `system:serviceaccount:${operatorNamespace}:plattr-operator`,
        [`${oidcIssuer}:aud`]: 'sts.amazonaws.com',
      },
    });

    const operatorRole = new iam.Role(this, 'OperatorIrsaRole', {
      assumedBy: new iam.FederatedPrincipal(
        props.oidcProviderArn,
        {
          StringEquals: irsaCondition,
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      description: 'IRSA role for the Plattr operator',
    });

    // S3 permissions for storage reconciler
    operatorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3:CreateBucket',
          's3:DeleteBucket',
          's3:PutBucketPolicy',
          's3:PutBucketCors',
          's3:ListBucket',
          's3:DeleteObject',
          's3:GetObject',
          's3:PutObject',
        ],
        resources: ['arn:aws:s3:::plattr-*', 'arn:aws:s3:::plattr-*/*'],
      }),
    );

    // Secrets Manager permissions
    operatorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [dbSecret.secretArn],
      }),
    );

    // STS permissions for future per-app IRSA roles
    operatorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'iam:ResourceTag/platform.internal/managed-by': 'plattr-operator',
          },
        },
      }),
    );

    // -------------------------------------------------------
    // 6. Deploy operator via Helm chart
    // -------------------------------------------------------
    const operatorChartAsset = new s3assets.Asset(this, 'OperatorChartAsset', {
      path: path.resolve(__dirname, '../../../../manifests/helm/plattr-operator'),
    });

    cluster.addHelmChart('PlattrOperator', {
      chartAsset: operatorChartAsset,
      namespace: operatorNamespace,
      release: 'plattr-operator',
      values: {
        image: {
          repository: props.operatorEcrRepoUri,
          tag: 'latest',
          pullPolicy: 'Always',
        },
        serviceAccount: {
          create: true,
          name: 'plattr-operator',
          annotations: {
            'eks.amazonaws.com/role-arn': operatorRole.roleArn,
          },
        },
        config: {
          dbSecretArn: dbSecret.secretArn,
          dbHost: props.auroraClusterEndpoint,
          dbName: 'plattr',
          awsRegion: this.region,
          baseDomain: props.baseDomain,
          leaderElection: 'true',
          keycloakAdminUrl: `http://keycloak-http.${operatorNamespace}:80`,
          keycloakAdminUser: 'admin',
          redisEndpoint: props.redisEndpoint || '',
          opensearchEndpoint: props.opensearchEndpoint || '',
        },
      },
    });

    // -------------------------------------------------------
    // 7. Environment namespaces
    // -------------------------------------------------------
    const namespaces = props.prodMode ? ['production'] : ['staging', 'uat', 'production'];
    for (const env of namespaces) {
      const ns = cluster.addManifest(`Namespace-${env}`, {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: {
          name: env,
          labels: {
            'platform.internal/environment': env,
            'platform.internal/managed-by': 'plattr-cdk',
          },
        },
      });

      // Resource quotas per environment
      const quota = cluster.addManifest(`ResourceQuota-${env}`, {
        apiVersion: 'v1',
        kind: 'ResourceQuota',
        metadata: {
          name: 'plattr-quota',
          namespace: env,
        },
        spec: {
          hard: {
            'requests.cpu': env === 'production' ? '16' : '8',
            'requests.memory': env === 'production' ? '32Gi' : '16Gi',
            'limits.cpu': env === 'production' ? '32' : '16',
            'limits.memory': env === 'production' ? '64Gi' : '32Gi',
            pods: env === 'production' ? '100' : '50',
          },
        },
      });
      quota.node.addDependency(ns);
    }

    // -------------------------------------------------------
    // 8. Supporting add-ons (conditional)
    // -------------------------------------------------------
    if (props.installCertManager !== false) {
      const certManager = cluster.addHelmChart('CertManager', {
        chart: 'cert-manager',
        version: 'v1.17.2',
        repository: 'https://charts.jetstack.io',
        namespace: 'cert-manager',
        release: 'cert-manager',
        createNamespace: true,
        timeout: cdk.Duration.minutes(10),
        values: {
          installCRDs: true,
          startupapicheck: {
            timeout: '5m',
          },
        },
      });

      // ClusterIssuer for Let's Encrypt (must wait for cert-manager CRDs)
      const clusterIssuer = cluster.addManifest('ClusterIssuer-LetsEncrypt', {
        apiVersion: 'cert-manager.io/v1',
        kind: 'ClusterIssuer',
        metadata: {
          name: 'letsencrypt-prod',
        },
        spec: {
          acme: {
            server: 'https://acme-v02.api.letsencrypt.org/directory',
            email: `plattr@${props.baseDomain}`,
            privateKeySecretRef: {
              name: 'letsencrypt-prod-key',
            },
            solvers: [
              {
                http01: {
                  ingress: {
                    class: 'traefik',
                  },
                },
              },
            ],
          },
        },
      });
      clusterIssuer.node.addDependency(certManager);
    }

    if (props.installExternalDns !== false) {
      cluster.addHelmChart('ExternalDns', {
        chart: 'external-dns',
        repository: 'https://kubernetes-sigs.github.io/external-dns/',
        namespace: 'external-dns',
        release: 'external-dns',
        createNamespace: true,
        timeout: cdk.Duration.minutes(10),
        values: {
          provider: 'aws',
          domainFilters: [props.baseDomain],
          policy: 'sync',
          aws: {
            zoneType: 'public',
          },
          txtOwnerId: 'plattr-external-dns',
        },
      });
    }

    if (props.installTraefik !== false) {
      cluster.addHelmChart('Traefik', {
        chart: 'traefik',
        repository: 'https://traefik.github.io/charts',
        namespace: 'traefik',
        release: 'traefik',
        createNamespace: true,
        timeout: cdk.Duration.minutes(10),
        values: {
          service: {
            type: 'LoadBalancer',
            annotations: {
              'service.beta.kubernetes.io/aws-load-balancer-type': 'nlb',
              'service.beta.kubernetes.io/aws-load-balancer-scheme':
                'internet-facing',
            },
          },
        },
      });
    }

    // -------------------------------------------------------
    // 9. Keycloak for managed auth (conditional)
    // -------------------------------------------------------
    if (props.installKeycloak !== false) {
      cluster.addHelmChart('Keycloak', {
        chart: 'keycloak',
        repository: 'https://codecentric.github.io/helm-charts',
        namespace: operatorNamespace,
        release: 'keycloak',
        values: {
          replicas: 2,
          postgresql: { enabled: false },
          extraEnv: [
            { name: 'KC_DB', value: 'postgres' },
            {
              name: 'KC_DB_URL',
              valueFrom: { secretKeyRef: { name: 'keycloak-db', key: 'jdbc-url' } },
            },
            {
              name: 'KC_DB_USERNAME',
              valueFrom: { secretKeyRef: { name: 'keycloak-db', key: 'username' } },
            },
            {
              name: 'KC_DB_PASSWORD',
              valueFrom: { secretKeyRef: { name: 'keycloak-db', key: 'password' } },
            },
            { name: 'KC_HOSTNAME', value: `auth.${props.baseDomain}` },
            { name: 'KC_PROXY_HEADERS', value: 'xforwarded' },
            { name: 'KC_HTTP_ENABLED', value: 'true' },
            { name: 'KC_HEALTH_ENABLED', value: 'true' },
          ],
          ingress: {
            enabled: true,
            ingressClassName: 'traefik',
            hostname: `auth.${props.baseDomain}`,
            annotations: {
              'cert-manager.io/cluster-issuer': 'letsencrypt-prod',
            },
            tls: true,
          },
          resources: {
            requests: { cpu: '500m', memory: '1Gi' },
            limits: { cpu: '2000m', memory: '2Gi' },
          },
        },
      });
    }

    // -------------------------------------------------------
    // Outputs
    // -------------------------------------------------------
    new cdk.CfnOutput(this, 'OperatorRoleArn', {
      value: operatorRole.roleArn,
      description: 'IRSA role ARN for the Plattr operator',
    });

    new cdk.CfnOutput(this, 'DbSecretArn', {
      value: dbSecret.secretArn,
      description: 'Secrets Manager ARN for DB admin credentials',
    });
  }
}
