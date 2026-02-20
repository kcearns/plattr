import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
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
  /** Base domain for app ingresses (e.g. platform.company.dev) */
  baseDomain: string;
  /** Route 53 hosted zone ID for the base domain */
  hostedZoneId: string;
  /** Install cert-manager Helm chart (default: true) */
  installCertManager?: boolean;
  /** Install external-dns Helm chart (default: true) */
  installExternalDns?: boolean;
  /** Install ingress-nginx Helm chart (default: true) */
  installIngressNginx?: boolean;
  /** Install Keycloak Helm chart for managed auth (default: true) */
  installKeycloak?: boolean;
}

export class PlattrOperatorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PlattrOperatorStackProps) {
    super(scope, id, props);

    const operatorNamespace = 'plattr-system';

    // -------------------------------------------------------
    // Import existing EKS cluster
    // -------------------------------------------------------
    const oidcProvider = eks.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'ImportedOidc',
      props.oidcProviderArn,
    );

    const cluster = eks.Cluster.fromClusterAttributes(this, 'ImportedCluster', {
      clusterName: props.eksClusterName,
      kubectlRoleArn: props.kubectlRoleArn,
      openIdConnectProvider: oidcProvider,
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
    // 4. ECR repository for operator image
    // -------------------------------------------------------
    const ecrRepo = new ecr.Repository(this, 'OperatorEcrRepo', {
      repositoryName: 'plattr-operator',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          maxImageCount: 25,
          description: 'Keep last 25 images',
        },
      ],
    });

    // -------------------------------------------------------
    // 5. IRSA — IAM role for the operator ServiceAccount
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
    cluster.addHelmChart('PlattrOperator', {
      chart: path.resolve(
        __dirname,
        '../../../../manifests/helm/plattr-operator',
      ),
      namespace: operatorNamespace,
      release: 'plattr-operator',
      values: {
        image: {
          repository: ecrRepo.repositoryUri,
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
        },
      },
    });

    // -------------------------------------------------------
    // 7. Environment namespaces
    // -------------------------------------------------------
    for (const env of ['staging', 'uat', 'production']) {
      cluster.addManifest(`Namespace-${env}`, {
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
      cluster.addManifest(`ResourceQuota-${env}`, {
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
    }

    // -------------------------------------------------------
    // 8. Supporting add-ons (conditional)
    // -------------------------------------------------------
    if (props.installCertManager !== false) {
      cluster.addHelmChart('CertManager', {
        chart: 'cert-manager',
        repository: 'https://charts.jetstack.io',
        namespace: 'cert-manager',
        release: 'cert-manager',
        createNamespace: true,
        values: {
          installCRDs: true,
        },
      });

      // ClusterIssuer for Let's Encrypt
      cluster.addManifest('ClusterIssuer-LetsEncrypt', {
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
                    class: 'nginx',
                  },
                },
              },
            ],
          },
        },
      });
    }

    if (props.installExternalDns !== false) {
      cluster.addHelmChart('ExternalDns', {
        chart: 'external-dns',
        repository: 'https://kubernetes-sigs.github.io/external-dns/',
        namespace: 'external-dns',
        release: 'external-dns',
        createNamespace: true,
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

    if (props.installIngressNginx !== false) {
      cluster.addHelmChart('IngressNginx', {
        chart: 'ingress-nginx',
        repository: 'https://kubernetes.github.io/ingress-nginx',
        namespace: 'ingress-nginx',
        release: 'ingress-nginx',
        createNamespace: true,
        values: {
          controller: {
            service: {
              type: 'LoadBalancer',
              annotations: {
                'service.beta.kubernetes.io/aws-load-balancer-type': 'nlb',
                'service.beta.kubernetes.io/aws-load-balancer-scheme':
                  'internet-facing',
              },
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
            ingressClassName: 'nginx',
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
    new cdk.CfnOutput(this, 'EcrRepoUri', {
      value: ecrRepo.repositoryUri,
      description: 'ECR repository URI for the Plattr operator image',
    });

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
