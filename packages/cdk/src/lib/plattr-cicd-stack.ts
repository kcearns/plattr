import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export interface PlattrCicdStackProps extends cdk.StackProps {
  /** GitHub organization name (e.g. "your-org") */
  githubOrg: string;
  /** GitHub repository name filter (optional, e.g. "my-app"). If unset, allows all repos in the org. */
  githubRepoFilter?: string;
  /** Production account ID. When set, the prod deploy role gets sts:AssumeRole permission into the prod account. */
  prodAccountId?: string;
}

export class PlattrCicdStack extends cdk.Stack {
  public readonly deployRole: iam.Role;
  public readonly prodDeployRole: iam.Role;
  public readonly appEcrRepo: ecr.IRepository;

  constructor(scope: Construct, id: string, props: PlattrCicdStackProps) {
    super(scope, id, props);

    // -------------------------------------------------------
    // 1. GitHub OIDC Provider
    // -------------------------------------------------------
    // Check if the provider already exists; if so, import it.
    // CDK will fail if you try to create a duplicate OIDC provider.
    // Set this to an existing provider ARN if you already have one,
    // or let CDK create it.
    const githubOidcProvider = new iam.OpenIdConnectProvider(
      this,
      'GithubOidcProvider',
      {
        url: 'https://token.actions.githubusercontent.com',
        clientIds: ['sts.amazonaws.com'],
        thumbprints: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
      },
    );

    // -------------------------------------------------------
    // 2. Shared ECR repository for app images
    // -------------------------------------------------------
    this.appEcrRepo = new ecr.Repository(this, 'AppEcrRepo', {
      repositoryName: 'plattr-apps',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          maxImageCount: 50,
          description: 'Keep last 50 images',
        },
      ],
    });

    // -------------------------------------------------------
    // 3. CI deploy role (non-prod)
    // -------------------------------------------------------
    const repoCondition = props.githubRepoFilter
      ? `repo:${props.githubOrg}/${props.githubRepoFilter}:*`
      : `repo:${props.githubOrg}/*:*`;

    this.deployRole = new iam.Role(this, 'CiDeployRole', {
      roleName: 'plattr-ci-deploy',
      assumedBy: new iam.FederatedPrincipal(
        githubOidcProvider.openIdConnectProviderArn,
        {
          StringLike: {
            'token.actions.githubusercontent.com:sub': repoCondition,
          },
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      description: 'IAM role for GitHub Actions CI/CD (non-prod deployments)',
    });

    // ECR permissions
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchGetImage',
          'ecr:GetDownloadUrlForLayer',
          'ecr:PutImage',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
          'ecr:BatchCheckLayerAvailability',
        ],
        resources: [this.appEcrRepo.repositoryArn],
      }),
    );

    // ecr:GetAuthorizationToken needs * resource
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );

    // EKS permissions (to get cluster endpoint for kubectl)
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['eks:DescribeCluster'],
        resources: ['*'],
      }),
    );

    // -------------------------------------------------------
    // 4. CI deploy role (production — main branch only)
    // -------------------------------------------------------
    const prodRepoCondition = props.githubRepoFilter
      ? `repo:${props.githubOrg}/${props.githubRepoFilter}:ref:refs/heads/main`
      : `repo:${props.githubOrg}/*:ref:refs/heads/main`;

    this.prodDeployRole = new iam.Role(this, 'CiDeployProdRole', {
      roleName: 'plattr-ci-deploy-prod',
      assumedBy: new iam.FederatedPrincipal(
        githubOidcProvider.openIdConnectProviderArn,
        {
          StringLike: {
            'token.actions.githubusercontent.com:sub': prodRepoCondition,
          },
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      description:
        'IAM role for GitHub Actions CI/CD (production deployments, main branch only)',
    });

    // Same ECR permissions as non-prod
    this.prodDeployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchGetImage',
          'ecr:GetDownloadUrlForLayer',
          'ecr:PutImage',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
          'ecr:BatchCheckLayerAvailability',
        ],
        resources: [this.appEcrRepo.repositoryArn],
      }),
    );

    this.prodDeployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );

    this.prodDeployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['eks:DescribeCluster'],
        resources: ['*'],
      }),
    );

    // Cross-account: allow prod deploy role to assume a role in the prod account
    if (props.prodAccountId) {
      this.prodDeployRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole'],
          resources: [
            `arn:aws:iam::${props.prodAccountId}:role/plattr-ci-deploy-prod`,
          ],
        }),
      );

      // Allow prod deploy role to describe the prod EKS cluster
      this.prodDeployRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['eks:DescribeCluster'],
          resources: [
            `arn:aws:eks:*:${props.prodAccountId}:cluster/plattr-prod`,
          ],
        }),
      );
    }

    // -------------------------------------------------------
    // Outputs
    // -------------------------------------------------------
    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: this.deployRole.roleArn,
      description: 'IAM role ARN for non-prod CI/CD deployments',
    });

    new cdk.CfnOutput(this, 'ProdDeployRoleArn', {
      value: this.prodDeployRole.roleArn,
      description: 'IAM role ARN for production CI/CD deployments (main branch only)',
    });

    new cdk.CfnOutput(this, 'AppEcrRepoUri', {
      value: this.appEcrRepo.repositoryUri,
      description: 'ECR repository URI for application images',
    });
  }
}
