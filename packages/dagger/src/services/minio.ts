import { dag, Service } from "@dagger.io/dagger"

/**
 * Start a MinIO (S3-compatible) storage service.
 *
 * - Default credentials: minioadmin / minioadmin
 * - Port 9000: S3 API
 * - Port 9001: Web console
 */
export function startMinio(): Service {
  return dag
    .container()
    .from("minio/minio:latest")
    .withEnvVariable("MINIO_ROOT_USER", "minioadmin")
    .withEnvVariable("MINIO_ROOT_PASSWORD", "minioadmin")
    .withExposedPort(9000)
    .withExposedPort(9001)
    .asService({ args: ["server", "/data", "--console-address", ":9001"], useEntrypoint: true })
}

/**
 * Create buckets in a running MinIO service using the minio/mc client.
 * Waits for MinIO to be ready with a retry loop, then creates each bucket.
 */
export async function createBuckets(
  minioService: Service,
  buckets: Array<{ name: string }>,
  appName: string,
): Promise<void> {
  // Build the mc commands: set alias, then create each bucket
  const bucketCommands = buckets
    .map((b) => `mc mb minio/${appName}-${b.name} --ignore-existing`)
    .join(" && ")

  const script = [
    // Retry loop to wait for MinIO readiness
    `for i in $(seq 1 30); do`,
    `  mc alias set minio http://storage:9000 minioadmin minioadmin 2>/dev/null && break`,
    `  echo "Waiting for MinIO... attempt $i"`,
    `  sleep 1`,
    `done`,
    bucketCommands,
  ].join("\n")

  await dag
    .container()
    .from("minio/mc:latest")
    .withServiceBinding("storage", minioService)
    .withExec(["sh", "-c", script])
    .stdout()
}
