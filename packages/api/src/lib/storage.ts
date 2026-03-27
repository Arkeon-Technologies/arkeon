import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Readable } from "node:stream";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

export interface FileStorage {
  put(
    key: string,
    body: Uint8Array,
    opts: { contentType: string; metadata?: Record<string, string> },
  ): Promise<void>;
  get(
    key: string,
  ): Promise<{ body: ReadableStream; contentType: string; size: number } | null>;
  head(key: string): Promise<{ size: number; contentType: string } | null>;
}

// --- Local filesystem backend ---

interface FileMeta {
  contentType: string;
  size: number;
  metadata?: Record<string, string>;
}

export class LocalFileStorage implements FileStorage {
  constructor(private root: string) {}

  private filePath(key: string) {
    return join(this.root, key);
  }

  private metaPath(key: string) {
    return join(this.root, key + ".meta.json");
  }

  async put(
    key: string,
    body: Uint8Array,
    opts: { contentType: string; metadata?: Record<string, string> },
  ): Promise<void> {
    const fp = this.filePath(key);
    await mkdir(dirname(fp), { recursive: true });

    const meta: FileMeta = {
      contentType: opts.contentType,
      size: body.byteLength,
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    };

    await writeFile(fp, body);
    await writeFile(this.metaPath(key), JSON.stringify(meta));
  }

  async get(
    key: string,
  ): Promise<{ body: ReadableStream; contentType: string; size: number } | null> {
    const meta = await this.readMeta(key);
    if (!meta) return null;

    const data = await readFile(this.filePath(key)).catch(() => null);
    if (!data) return null;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });

    return { body: stream, contentType: meta.contentType, size: meta.size };
  }

  async head(key: string): Promise<{ size: number; contentType: string } | null> {
    const meta = await this.readMeta(key);
    if (!meta) return null;
    return { size: meta.size, contentType: meta.contentType };
  }

  private async readMeta(key: string): Promise<FileMeta | null> {
    try {
      const raw = await readFile(this.metaPath(key), "utf-8");
      return JSON.parse(raw) as FileMeta;
    } catch {
      return null;
    }
  }
}

// --- S3-compatible backend ---

export class S3FileStorage implements FileStorage {
  private client: S3Client;
  private bucket: string;

  constructor(opts: {
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
  }) {
    this.bucket = opts.bucket;
    this.client = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region ?? "auto",
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
      forcePathStyle: true,
    });
  }

  async put(
    key: string,
    body: Uint8Array,
    opts: { contentType: string; metadata?: Record<string, string> },
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType,
        Metadata: opts.metadata,
      }),
    );
  }

  async get(
    key: string,
  ): Promise<{ body: ReadableStream; contentType: string; size: number } | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );

      if (!res.Body) return null;

      const webStream =
        res.Body instanceof ReadableStream
          ? res.Body
          : Readable.toWeb(res.Body as Readable) as ReadableStream;

      return {
        body: webStream,
        contentType: res.ContentType ?? "application/octet-stream",
        size: res.ContentLength ?? 0,
      };
    } catch (err: any) {
      if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async head(key: string): Promise<{ size: number; contentType: string } | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: res.ContentLength ?? 0,
        contentType: res.ContentType ?? "application/octet-stream",
      };
    } catch (err: any) {
      if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw err;
    }
  }
}

// --- Singleton ---

function createStorage(): FileStorage {
  if (process.env.STORAGE_BACKEND === "s3") {
    const endpoint = process.env.S3_ENDPOINT;
    const bucket = process.env.S3_BUCKET;
    const accessKeyId = process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error(
        "S3 storage requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY",
      );
    }

    return new S3FileStorage({
      endpoint,
      bucket,
      accessKeyId,
      secretAccessKey,
      region: process.env.S3_REGION,
    });
  }

  return new LocalFileStorage(process.env.STORAGE_DIR ?? "./data/files");
}

export const storage: FileStorage = createStorage();
