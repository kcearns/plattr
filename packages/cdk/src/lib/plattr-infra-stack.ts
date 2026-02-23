import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as eks from '@aws-cdk/aws-eks-v2-alpha';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

export interface PlattrInfraStackProps extends cdk.StackProps {
  /** Availability zones to use (default: CDK picks first 2 in region) */
  availabilityZones?: string[];
  /** EKS cluster name (default: 'plattr-nonprod') */
  clusterName?: string;
  /** Aurora Serverless v2 minimum ACU (default: 0.5) */
  auroraMinCapacity?: number;
  /** Aurora Serverless v2 maximum ACU (default: 4) */
  auroraMaxCapacity?: number;
}

export class PlattrInfraStack extends cdk.Stack {
  /** The EKS cluster */
  public readonly cluster: eks.Cluster;
  /** The IAM role with kubectl/masters access to the cluster */
  public readonly kubectlRole: iam.Role;
  /** The Aurora Serverless v2 database cluster */
  public readonly auroraCluster: rds.DatabaseCluster;
  /** The Aurora security group */
  public readonly auroraSecurityGroup: ec2.SecurityGroup;
  /** The native OIDC provider ARN for IRSA */
  public readonly oidcProviderArn: string;
  /** The ECR repository for the operator image */
  public readonly operatorEcrRepo: ecr.Repository;

  private readonly _availabilityZones?: string[];

  get availabilityZones(): string[] {
    return this._availabilityZones ?? super.availabilityZones;
  }

  constructor(scope: Construct, id: string, props: PlattrInfraStackProps = {}) {
    super(scope, id, props);

    this._availabilityZones = props.availabilityZones;

    const clusterName = props.clusterName ?? 'plattr-nonprod';
    const auroraMinCapacity = props.auroraMinCapacity ?? 0.5;
    const auroraMaxCapacity = props.auroraMaxCapacity ?? 4;

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
      description: 'Role for CDK kubectl operations on the Plattr EKS cluster',
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
    // 3. Aurora Serverless v2 — PostgreSQL 16.4
    // -------------------------------------------------------
    this.auroraSecurityGroup = new ec2.SecurityGroup(this, 'AuroraSg', {
      vpc,
      description: 'Plattr Aurora PostgreSQL security group',
      allowAllOutbound: false,
    });

    // Allow EKS cluster security group → Aurora on port 5432
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
        secretName: 'plattr/aurora-admin',
      }),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      storageEncrypted: true,
    });

    // -------------------------------------------------------
    // 4. OIDC Provider (native) for IRSA
    // -------------------------------------------------------
    const oidcProvider = new eks.OidcProviderNative(this, 'OidcProvider', {
      url: this.cluster.clusterOpenIdConnectIssuerUrl,
    });
    this.oidcProviderArn = oidcProvider.openIdConnectProviderArn;

    // -------------------------------------------------------
    // 5. ECR repository for operator image
    // -------------------------------------------------------
    this.operatorEcrRepo = new ecr.Repository(this, 'OperatorEcrRepo', {
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

    new cdk.CfnOutput(this, 'EcrRepoUri', {
      value: this.operatorEcrRepo.repositoryUri,
      description: 'ECR repository URI for the Plattr operator image',
    });
  }
}
