import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as eks from '@aws-cdk/aws-eks-v2-alpha';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import { Construct } from 'constructs';

export interface PlattrProdInfraStackProps extends cdk.StackProps {
  /** Availability zones to use (default: CDK picks first 2 in region) */
  availabilityZones?: string[];
  /** EKS cluster name (default: 'plattr-prod') */
  clusterName?: string;
  /** Aurora Serverless v2 minimum ACU (default: 1) */
  auroraMinCapacity?: number;
  /** Aurora Serverless v2 maximum ACU (default: 8) */
  auroraMaxCapacity?: number;
  /** OpenSearch instance type (default: 't3.medium.search') */
  opensearchInstanceType?: string;
  /** OpenSearch data node count (default: 2) */
  opensearchDataNodeCount?: number;
  /** Non-prod account ID for cross-account ECR pull */
  nonprodAccountId?: string;
}

export class PlattrProdInfraStack extends cdk.Stack {
  public readonly cluster: eks.Cluster;
  public readonly kubectlRole: iam.Role;
  public readonly auroraCluster: rds.DatabaseCluster;
  public readonly auroraSecurityGroup: ec2.SecurityGroup;
  public readonly elasticacheSecurityGroup: ec2.SecurityGroup;
  public readonly opensearchSecurityGroup: ec2.SecurityGroup;
  public readonly redisEndpoint: string;
  public readonly opensearchEndpoint: string;
  public readonly oidcProviderArn: string;
  public readonly operatorEcrRepo: ecr.Repository;

  private readonly _availabilityZones?: string[];

  get availabilityZones(): string[] {
    return this._availabilityZones ?? super.availabilityZones;
  }

  constructor(scope: Construct, id: string, props: PlattrProdInfraStackProps = {}) {
    super(scope, id, props);

    this._availabilityZones = props.availabilityZones;

    const clusterName = props.clusterName ?? 'plattr-prod';
    const auroraMinCapacity = props.auroraMinCapacity ?? 1;
    const auroraMaxCapacity = props.auroraMaxCapacity ?? 8;
    const opensearchInstanceType = props.opensearchInstanceType ?? 't3.medium.search';
    const opensearchDataNodeCount = props.opensearchDataNodeCount ?? 2;

    // -------------------------------------------------------
    // 1. VPC — public/private subnets, 1 NAT gateway, 2 AZs
    // -------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // -------------------------------------------------------
    // 2. EKS Cluster — K8s 1.33, Auto Mode, OIDC
    // -------------------------------------------------------
    this.kubectlRole = new iam.Role(this, 'KubectlRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.AccountRootPrincipal(),
        new iam.ServicePrincipal('lambda.amazonaws.com'),
      ),
      description: 'Role for CDK kubectl operations on the Plattr prod EKS cluster',
    });

    this.cluster = new eks.Cluster(this, 'EksCluster', {
      clusterName,
      version: eks.KubernetesVersion.V1_33,
      vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      defaultCapacityType: eks.DefaultCapacityType.AUTOMODE,
      compute: {
        nodePools: ['system', 'general-purpose'],
      },
      mastersRole: this.kubectlRole,
    });

    new eks.Addon(this, 'MetricsServerAddon', {
      addonName: 'metrics-server',
      cluster: this.cluster,
    });

    // -------------------------------------------------------
    // 3. Aurora Serverless v2 — PostgreSQL 16.4 (higher ACUs)
    // -------------------------------------------------------
    this.auroraSecurityGroup = new ec2.SecurityGroup(this, 'AuroraSg', {
      vpc,
      description: 'Plattr prod Aurora PostgreSQL security group',
      allowAllOutbound: false,
    });
    this.auroraSecurityGroup.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    this.auroraSecurityGroup.addIngressRule(
      this.cluster.clusterSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow EKS pods to connect to Aurora',
    );

    this.auroraCluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      serverlessV2MinCapacity: auroraMinCapacity,
      serverlessV2MaxCapacity: auroraMaxCapacity,
      writer: rds.ClusterInstance.serverlessV2('Writer'),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.auroraSecurityGroup],
      defaultDatabaseName: 'plattr',
      credentials: rds.Credentials.fromGeneratedSecret('plattr_admin', {
        secretName: 'plattr/aurora-admin-prod',
      }),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      storageEncrypted: true,
    });

    // -------------------------------------------------------
    // 4. ElastiCache Serverless (Redis 7)
    // -------------------------------------------------------
    this.elasticacheSecurityGroup = new ec2.SecurityGroup(this, 'ElastiCacheSg', {
      vpc,
      description: 'Plattr prod ElastiCache Redis security group',
      allowAllOutbound: false,
    });
    this.elasticacheSecurityGroup.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    this.elasticacheSecurityGroup.addIngressRule(
      this.cluster.clusterSecurityGroup,
      ec2.Port.tcp(6379),
      'Allow EKS pods to connect to ElastiCache',
    );

    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Plattr prod Redis subnet group',
      subnetIds: vpc.privateSubnets.map(s => s.subnetId),
      cacheSubnetGroupName: 'plattr-prod-redis-subnets',
    });

    const redisCluster = new elasticache.CfnServerlessCache(this, 'RedisCluster', {
      engine: 'redis',
      serverlessCacheName: 'plattr-prod-redis',
      majorEngineVersion: '7',
      securityGroupIds: [this.elasticacheSecurityGroup.securityGroupId],
      subnetIds: vpc.privateSubnets.map(s => s.subnetId),
    });

    this.redisEndpoint = redisCluster.attrEndpointAddress;

    // -------------------------------------------------------
    // 5. OpenSearch Service domain
    // -------------------------------------------------------
    this.opensearchSecurityGroup = new ec2.SecurityGroup(this, 'OpenSearchSg', {
      vpc,
      description: 'Plattr prod OpenSearch security group',
      allowAllOutbound: false,
    });
    this.opensearchSecurityGroup.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    this.opensearchSecurityGroup.addIngressRule(
      this.cluster.clusterSecurityGroup,
      ec2.Port.tcp(443),
      'Allow EKS pods to connect to OpenSearch',
    );

    const osDomain = new opensearch.Domain(this, 'OpenSearchDomain', {
      domainName: 'plattr-prod-search',
      version: opensearch.EngineVersion.OPENSEARCH_2_11,
      vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      securityGroups: [this.opensearchSecurityGroup],
      capacity: {
        dataNodeInstanceType: opensearchInstanceType,
        dataNodes: opensearchDataNodeCount,
      },
      ebs: {
        volumeSize: 100,
        volumeType: ec2.EbsDeviceVolumeType.GP3,
      },
      encryptionAtRest: { enabled: true },
      nodeToNodeEncryption: true,
      enforceHttps: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.opensearchEndpoint = osDomain.domainEndpoint;

    // -------------------------------------------------------
    // 6. Cross-account ECR pull (if nonprod account specified)
    // -------------------------------------------------------
    if (props.nonprodAccountId) {
      const ecrPullRole = new iam.Role(this, 'EcrCrossAccountPullRole', {
        roleName: 'plattr-prod-ecr-pull',
        assumedBy: new iam.ServicePrincipal('eks.amazonaws.com'),
        description: 'Allows prod EKS to pull images from non-prod ECR',
      });

      ecrPullRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            'ecr:GetAuthorizationToken',
            'ecr:BatchGetImage',
            'ecr:GetDownloadUrlForLayer',
            'ecr:BatchCheckLayerAvailability',
          ],
          resources: [
            `arn:aws:ecr:${this.region}:${props.nonprodAccountId}:repository/plattr-apps`,
            `arn:aws:ecr:${this.region}:${props.nonprodAccountId}:repository/plattr-operator`,
          ],
        }),
      );

      ecrPullRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['ecr:GetAuthorizationToken'],
          resources: ['*'],
        }),
      );
    }

    // -------------------------------------------------------
    // OIDC Provider (native) for IRSA
    // -------------------------------------------------------
    const oidcProvider = new eks.OidcProviderNative(this, 'OidcProvider', {
      url: this.cluster.clusterOpenIdConnectIssuerUrl,
    });
    this.oidcProviderArn = oidcProvider.openIdConnectProviderArn;

    // -------------------------------------------------------
    // ECR repository for operator image
    // -------------------------------------------------------
    this.operatorEcrRepo = new ecr.Repository(this, 'OperatorEcrRepo', {
      repositoryName: 'plattr-operator-prod',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          maxImageCount: 25,
          description: 'Keep last 25 images',
        },
      ],
    });

    // -------------------------------------------------------
    // Outputs
    // -------------------------------------------------------
    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      description: 'EKS cluster name',
    });

    new cdk.CfnOutput(this, 'KubectlRoleArn', {
      value: this.kubectlRole.roleArn,
      description: 'IAM role ARN for kubectl access',
    });

    new cdk.CfnOutput(this, 'OidcProviderArn', {
      value: oidcProvider.openIdConnectProviderArn,
      description: 'OIDC provider ARN for IRSA',
    });

    new cdk.CfnOutput(this, 'AuroraEndpoint', {
      value: this.auroraCluster.clusterEndpoint.hostname,
      description: 'Aurora cluster writer endpoint',
    });

    new cdk.CfnOutput(this, 'AuroraSecurityGroupId', {
      value: this.auroraSecurityGroup.securityGroupId,
      description: 'Aurora security group ID',
    });

    new cdk.CfnOutput(this, 'RedisEndpoint', {
      value: this.redisEndpoint,
      description: 'ElastiCache Redis endpoint',
    });

    new cdk.CfnOutput(this, 'OpenSearchEndpoint', {
      value: this.opensearchEndpoint,
      description: 'OpenSearch Service domain endpoint',
    });

    new cdk.CfnOutput(this, 'ElastiCacheSecurityGroupId', {
      value: this.elasticacheSecurityGroup.securityGroupId,
      description: 'ElastiCache security group ID',
    });

    new cdk.CfnOutput(this, 'OpenSearchSecurityGroupId', {
      value: this.opensearchSecurityGroup.securityGroupId,
      description: 'OpenSearch security group ID',
    });
  }
}
