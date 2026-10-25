import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export abstract class Storage {
  abstract get(key: string): Promise<Buffer | null>;
  abstract put(key: string, body: Buffer | string, contentType?: string, cacheControl?: string): Promise<void>;
  abstract has(key: string): Promise<boolean>;
  abstract delete(keys: string[]): Promise<void>;
  abstract deletePrefix(prefix: string): Promise<void>;
  abstract signedUrl(key: string, seconds: number): Promise<string | null>;
  abstract signedPutUrl(key: string, seconds: number): Promise<string | null>;
  abstract localPath(key: string): string | null;
}

export abstract class DeployStorage extends Storage {}

function checkKey(key: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-/@+]*$/.test(key) || key.includes('..')) throw new Error(`Invalid storage key: ${key}`);
  return key;
}

export class LocalStorage extends Storage {
  constructor(private readonly dir: string) {
    super();
  }

  localPath(key: string): string {
    return path.join(this.dir, checkKey(key));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.localPath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async put(key: string, body: Buffer | string): Promise<void> {
    const target = this.localPath(key);
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, body);
    await rename(temp, target);
  }

  async has(key: string): Promise<boolean> {
    try {
      await stat(this.localPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(keys: string[]): Promise<void> {
    await Promise.all(keys.map(key => rm(this.localPath(key), { force: true })));
  }

  async deletePrefix(prefix: string): Promise<void> {
    await rm(this.localPath(prefix.replace(/\/+$/, '')), { recursive: true, force: true });
  }

  async signedUrl(): Promise<string | null> {
    return null;
  }

  async signedPutUrl(): Promise<string | null> {
    return null;
  }
}

export class S3Storage extends Storage {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    region: string,
  ) {
    super();
    this.client = new S3Client({ region });
  }

  localPath(): null {
    return null;
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: checkKey(key) }));
      return Buffer.from(await response.Body!.transformToByteArray());
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
  }

  async put(key: string, body: Buffer | string, contentType?: string, cacheControl?: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: checkKey(key), Body: body, ContentType: contentType, CacheControl: cacheControl }));
  }

  async has(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: checkKey(key) }));
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === 'NotFound' || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false;
      throw error;
    }
  }

  async delete(keys: string[]): Promise<void> {
    for (let index = 0; index < keys.length; index += 1000) {
      const batch = keys.slice(index, index + 1000).map(key => ({ Key: checkKey(key) }));
      if (batch.length) await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch, Quiet: true } }));
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: checkKey(prefix), ContinuationToken: token }));
      await this.delete((page.Contents ?? []).map(object => object.Key!).filter(Boolean));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  signedUrl(key: string, seconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: checkKey(key) }), { expiresIn: seconds });
  }

  signedPutUrl(key: string, seconds: number): Promise<string> {
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: checkKey(key) }), { expiresIn: seconds });
  }
}
