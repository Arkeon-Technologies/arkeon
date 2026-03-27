import { mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { join, dirname } from "node:path";

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

const dataDir = process.env.STORAGE_DIR ?? "./data/files";
export const storage: FileStorage = new LocalFileStorage(dataDir);
