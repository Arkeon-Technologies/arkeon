import { basename, extname, resolve } from "node:path";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".csv": "text/csv",
  ".html": "text/html",
  ".xml": "application/xml",
  ".zip": "application/zip",
};

export function resolveFilePath(filePath: string): string {
  return resolve(filePath);
}

export function inferContentType(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

export function defaultFilename(filePath: string): string {
  return basename(filePath);
}

export function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) {
    return null;
  }
  const match = header.match(/filename="([^"]+)"/i);
  return match?.[1] ?? null;
}
