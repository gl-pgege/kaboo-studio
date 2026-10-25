import '@aws-sdk/signature-v4a';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import {
  CloudFrontKeyValueStoreClient,
  DeleteKeyCommand,
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  PutKeyCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { KeyValues } from './edge';

export abstract class RoutingStore implements KeyValues {
  abstract get(key: string): Promise<string | null>;
  abstract put(key: string, value: string): Promise<void>;
  abstract delete(key: string): Promise<void>;
}

export class LocalRoutingStore extends RoutingStore {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {
    super();
  }

  async get(key: string): Promise<string | null> {
    return (await this.read())[key] ?? null;
  }

  put(key: string, value: string): Promise<void> {
    return this.change(values => void (values[key] = value));
  }

  delete(key: string): Promise<void> {
    return this.change(values => void delete values[key]);
  }

  private async read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private change(edit: (values: Record<string, string>) => void): Promise<void> {
    const next = this.pending.then(async () => {
      const values = await this.read();
      edit(values);
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(values, null, 2));
      await rename(temp, this.file);
    });
    this.pending = next.catch(() => undefined);
    return next;
  }
}

const isConflict = (error: unknown) => {
  const name = (error as { name?: string }).name;
  return name === 'ConflictException' || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412;
};

export class KeyValueStoreRouting extends RoutingStore {
  private readonly client = new CloudFrontKeyValueStoreClient({ region: 'us-east-1' });

  constructor(private readonly arn: string) {
    super();
  }

  async get(key: string): Promise<string | null> {
    try {
      return (await this.client.send(new GetKeyCommand({ KvsARN: this.arn, Key: key }))).Value ?? null;
    } catch (error) {
      if ((error as { name?: string }).name === 'ResourceNotFoundException') return null;
      throw error;
    }
  }

  put(key: string, value: string): Promise<void> {
    return this.withEtag(async etag => void (await this.client.send(new PutKeyCommand({ KvsARN: this.arn, Key: key, Value: value, IfMatch: etag }))));
  }

  async delete(key: string): Promise<void> {
    if ((await this.get(key)) === null) return;
    await this.withEtag(async etag => void (await this.client.send(new DeleteKeyCommand({ KvsARN: this.arn, Key: key, IfMatch: etag }))));
  }

  private async withEtag(work: (etag: string) => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const { ETag } = await this.client.send(new DescribeKeyValueStoreCommand({ KvsARN: this.arn }));
      try {
        return await work(ETag!);
      } catch (error) {
        if (!isConflict(error) || attempt >= 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
  }
}

export abstract class EdgeCache {
  abstract invalidate(paths: string[]): Promise<void>;
}

export class NoEdgeCache extends EdgeCache {
  async invalidate(): Promise<void> {}
}

export class CloudFrontCache extends EdgeCache {
  private readonly client = new CloudFrontClient({ region: 'us-east-1' });

  constructor(private readonly distributionId: string) {
    super();
  }

  async invalidate(paths: string[]): Promise<void> {
    if (!paths.length) return;
    for (let index = 0; index < paths.length; index += 1000) {
      const batch = paths.slice(index, index + 1000);
      await this.client.send(
        new CreateInvalidationCommand({ DistributionId: this.distributionId, InvalidationBatch: { CallerReference: randomUUID(), Paths: { Quantity: batch.length, Items: batch } } }),
      );
    }
  }
}
