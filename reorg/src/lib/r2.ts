import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const REQUIRED_R2_ENV_VARS = [
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "R2_ENDPOINT",
] as const;

type RequiredR2EnvVar = (typeof REQUIRED_R2_ENV_VARS)[number];

function getEnv(name: RequiredR2EnvVar): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required backup environment variable: ${name}`);
  }
  return value;
}

export function getMissingR2EnvVars(): RequiredR2EnvVar[] {
  return REQUIRED_R2_ENV_VARS.filter((name) => !process.env[name]);
}

export function isR2Configured(): boolean {
  return getMissingR2EnvVars().length === 0;
}

export function getR2BucketName(): string {
  return getEnv("R2_BUCKET_NAME");
}

export function getR2Client(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: getEnv("R2_ENDPOINT"),
    forcePathStyle: true,
    credentials: {
      accessKeyId: getEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: getEnv("R2_SECRET_ACCESS_KEY"),
    },
  });
}

export async function getSignedDownloadUrl(
  storageKey: string,
  fileName: string,
  expiresInSeconds = 300
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: getR2BucketName(),
    Key: storageKey,
    ResponseContentDisposition: `attachment; filename="${fileName}"`,
  });

  return getSignedUrl(getR2Client(), command, { expiresIn: expiresInSeconds });
}

export async function getR2ObjectBytes(storageKey: string): Promise<Uint8Array> {
  const response = await getR2Client().send(
    new GetObjectCommand({
      Bucket: getR2BucketName(),
      Key: storageKey,
    })
  );

  if (!response.Body) {
    throw new Error("Backup file could not be read from Cloudflare R2.");
  }

  return response.Body.transformToByteArray();
}

/** Remove an object from the backup bucket (idempotent on S3-compatible stores). */
export async function deleteR2Object(storageKey: string): Promise<void> {
  await getR2Client().send(
    new DeleteObjectCommand({
      Bucket: getR2BucketName(),
      Key: storageKey,
    }),
  );
}
