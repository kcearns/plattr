import {
  S3Client,
  CreateBucketCommand,
  PutBucketCorsCommand,
  PutBucketPolicyCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3';
import * as k8s from '@kubernetes/client-node';
import { withRetry } from '../lib/retry';

let s3: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3) {
    const endpoint = process.env.AWS_ENDPOINT_URL;
    s3 = new S3Client({
      region: process.env.AWS_REGION || 'ca-central-1',
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
  }
  return s3;
}

function fullBucketName(appName: string, bucketName: string, environment: string): string {
  if (environment === 'preview') {
    // Preview app name already includes PR number (e.g., my-frontend-pr42)
    return `plattr-${appName}-${bucketName}`;
  }
  const prefix = environment === 'production' ? 'prod' : environment;
  return `plattr-${prefix}-${appName}-${bucketName}`;
}

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const coreApi = kc.makeApiClient(k8s.CoreV1Api);

export async function reconcileStorage(
  appName: string,
  buckets: Array<{ name: string; public: boolean }>,
  namespace: string,
  environment: string,
): Promise<{ ready: boolean; error?: string }> {
  try {
    const client = getS3Client();

    for (const bucket of buckets) {
      const name = fullBucketName(appName, bucket.name, environment);

      // Create bucket (idempotent, with retry)
      console.log(`  [S3] Creating bucket "${name}"...`);
      await withRetry(async () => {
        try {
          await client.send(new CreateBucketCommand({ Bucket: name }));
          console.log(`  [S3] Bucket "${name}" created`);
        } catch (err: any) {
          if (
            err.name === 'BucketAlreadyOwnedByYou' ||
            err.name === 'BucketAlreadyExists' ||
            err.Code === 'BucketAlreadyOwnedByYou' ||
            err.Code === 'BucketAlreadyExists'
          ) {
            console.log(`  [S3] Bucket "${name}" already exists`);
          } else {
            throw err;
          }
        }
      }, { maxRetries: 3 });

      // Set CORS
      await client.send(
        new PutBucketCorsCommand({
          Bucket: name,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: ['*'],
                AllowedMethods: ['GET', 'PUT', 'POST', 'DELETE'],
                AllowedHeaders: ['*'],
                MaxAgeSeconds: 3600,
              },
            ],
          },
        }),
      );

      // Public read policy
      if (bucket.public) {
        const policy = JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'PublicRead',
              Effect: 'Allow',
              Principal: '*',
              Action: 's3:GetObject',
              Resource: `arn:aws:s3:::${name}/*`,
            },
          ],
        });
        await client.send(new PutBucketPolicyCommand({ Bucket: name, Policy: policy }));
        console.log(`  [S3] Public read policy set on "${name}"`);
      }
    }

    // Build ConfigMap data
    const data: Record<string, string> = {
      S3_ENDPOINT:
        process.env.AWS_ENDPOINT_URL ||
        `https://s3.${process.env.AWS_REGION || 'ca-central-1'}.amazonaws.com`,
      S3_REGION: process.env.AWS_REGION || 'ca-central-1',
    };
    for (const bucket of buckets) {
      const key = `S3_BUCKET_${bucket.name.toUpperCase().replace(/-/g, '_')}`;
      data[key] = fullBucketName(appName, bucket.name, environment);
    }

    const configMapName = `${appName}-storage`;
    const configMap: k8s.V1ConfigMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: configMapName,
        namespace,
        labels: {
          'platform.internal/app': appName,
          'platform.internal/managed-by': 'plattr-operator',
        },
      },
      data,
    };

    try {
      await coreApi.createNamespacedConfigMap(namespace, configMap);
      console.log(`  [S3] ConfigMap "${configMapName}" created`);
    } catch (err: any) {
      if (err?.response?.statusCode === 409 || err?.statusCode === 409 || err?.code === 409) {
        await coreApi.replaceNamespacedConfigMap(configMapName, namespace, configMap);
        console.log(`  [S3] ConfigMap "${configMapName}" updated (already existed)`);
      } else {
        throw err;
      }
    }

    return { ready: true };
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  [S3] Error: ${message}`);
    return { ready: false, error: message };
  }
}

export async function cleanupStorage(
  appName: string,
  buckets: Array<{ name: string; public: boolean }>,
  namespace: string,
  environment: string,
): Promise<void> {
  const client = getS3Client();

  for (const bucket of buckets) {
    const name = fullBucketName(appName, bucket.name, environment);
    try {
      // Empty the bucket first
      const listed = await client.send(new ListObjectsV2Command({ Bucket: name }));
      if (listed.Contents && listed.Contents.length > 0) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: name,
            Delete: { Objects: listed.Contents.map(o => ({ Key: o.Key! })) },
          }),
        );
      }
      await client.send(new DeleteBucketCommand({ Bucket: name }));
      console.log(`  [S3] Bucket "${name}" deleted`);
    } catch (err: any) {
      if (err.name === 'NoSuchBucket' || err.Code === 'NoSuchBucket') {
        console.log(`  [S3] Bucket "${name}" already gone`);
      } else {
        console.error(`  [S3] Error deleting bucket "${name}": ${err.message}`);
      }
    }
  }

  // Delete ConfigMap
  const configMapName = `${appName}-storage`;
  try {
    await coreApi.deleteNamespacedConfigMap(configMapName, namespace);
    console.log(`  [S3] ConfigMap "${configMapName}" deleted`);
  } catch (err: any) {
    if (err?.response?.statusCode === 404 || err?.statusCode === 404 || err?.code === 404) {
      console.log(`  [S3] ConfigMap "${configMapName}" already gone`);
    } else {
      console.error(`  [S3] Error deleting ConfigMap: ${err.message}`);
    }
  }
}
