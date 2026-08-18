/**
 * Temporary Storage Service
 *
 * Uses Cloudflare R2 (S3-compatible) in production.
 * Falls back to local filesystem when R2_ACCOUNT_ID is not set (local dev).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.js';

const useLocal = !env.R2_ACCOUNT_ID;
const LOCAL_DIR = path.join(os.tmpdir(), 'scrima-clips');

/** Converts an S3 key (slashes) to a safe local filename */
function keyToLocalPath(key: string): string {
  return path.join(LOCAL_DIR, key.replace(/\//g, '__'));
}

export class TempStorageService {
  private s3: S3Client | null;
  private bucket: string;

  constructor() {
    this.bucket = env.R2_BUCKET_NAME ?? 'scrima-temp';
    this.s3 = useLocal
      ? null
      : new S3Client({
          region: 'auto',
          endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
          credentials: {
            accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
            secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '',
          },
        });

    if (useLocal) {
      fs.mkdir(LOCAL_DIR, { recursive: true }).catch(() => {});
    }
  }

  async upload(key: string, data: Buffer, contentType = 'video/mp4'): Promise<string> {
    if (!this.s3) {
      const filePath = keyToLocalPath(key);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, data);
      return key;
    }
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
      }),
    );
    return key;
  }

  async download(key: string): Promise<Buffer> {
    if (!this.s3) {
      return fs.readFile(keyToLocalPath(key));
    }
    const result = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async delete(key: string): Promise<void> {
    if (!this.s3) {
      await fs.unlink(keyToLocalPath(key)).catch(() => {});
      return;
    }
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async presignedUploadUrl(key: string, expiresInSeconds = 300): Promise<string> {
    if (!this.s3) return `local://${key}`;
    return getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: 'video/mp4' }),
      { expiresIn: expiresInSeconds },
    );
  }

  async presignedDownloadUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    if (!this.s3) return `local://${key}`;
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }
}
