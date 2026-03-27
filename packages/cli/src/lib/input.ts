import { readFileSync } from "node:fs";

type InputMode = "text" | "json" | "bytes";

const stdinCache = new Map<InputMode, Promise<string | Uint8Array>>();

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readStdinBytes(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function readSharedStdin(mode: InputMode): Promise<string | Uint8Array> {
  const cached = stdinCache.get(mode);
  if (cached) {
    return cached;
  }

  if (stdinCache.size > 0) {
    throw new Error("stdin has already been consumed by another argument in this command.");
  }

  const promise = mode === "bytes" ? readStdinBytes() : readStdinText();
  stdinCache.set(mode, promise);
  return promise;
}

function parseJson(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON from ${source}.`);
  }
}

export async function resolveTextInput(value: string): Promise<string> {
  if (value === "@-") {
    return String(await readSharedStdin("text"));
  }
  if (value.startsWith("@")) {
    return readFileSync(value.slice(1), "utf8");
  }
  return value;
}

export async function resolveJsonInput(value: string): Promise<unknown> {
  if (value === "@-") {
    return parseJson(String(await readSharedStdin("json")), "stdin");
  }
  if (value.startsWith("@")) {
    return parseJson(readFileSync(value.slice(1), "utf8"), value.slice(1));
  }
  return parseJson(value, "inline value");
}

export async function resolveBinaryInput(path: string): Promise<Uint8Array> {
  if (path === "-") {
    return await readSharedStdin("bytes") as Uint8Array;
  }
  return new Uint8Array(readFileSync(path));
}
