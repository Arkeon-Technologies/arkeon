const baseUrl = process.env.ARKE_API_URL ?? "http://localhost:8000";
const apiKey = process.env.ARKE_API_KEY ?? "";
let defaultSpaceId = process.env.ARKE_SPACE_ID ?? "";

const defaultHeaders: Record<string, string> = {
  Authorization: `ApiKey ${apiKey}`,
  "Content-Type": "application/json",
};

// ---------------------------------------------------------------------------
// Proxy / custom fetch
// ---------------------------------------------------------------------------

type FetchFn = typeof globalThis.fetch;
let customFetch: FetchFn | undefined;
let proxyInitDone = false;

function getProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    undefined
  );
}

async function ensureProxy(): Promise<void> {
  if (proxyInitDone || customFetch) return;
  proxyInitDone = true;

  const proxy = getProxyUrl();
  if (!proxy) return;

  try {
    const { ProxyAgent } = await import("undici");
    const dispatcher = new ProxyAgent(proxy);
    customFetch = (input, init?) =>
      globalThis.fetch(input, { ...init, dispatcher } as any);
  } catch {
    console.warn(
      `[arkeon-sdk] HTTP proxy detected (${proxy}) but undici is not installed. ` +
        `Install undici to enable proxy support: npm install undici`,
    );
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type ConfigureOptions = {
  /** Custom fetch implementation — overrides proxy auto-detection. */
  fetch?: FetchFn;
  /** Explicit proxy URL. Requires undici to be installed. */
  proxy?: string;
};

/**
 * Configure the SDK's HTTP transport.
 *
 * @example Auto-detect proxy from env vars (just install undici):
 *   // HTTPS_PROXY is read automatically — no code needed
 *
 * @example Explicit proxy:
 *   import { configure } from "@arkeon-technologies/sdk";
 *   configure({ proxy: "http://proxy.corp:8080" });
 *
 * @example Fully custom fetch:
 *   configure({ fetch: myCustomFetch });
 */
export async function configure(opts: ConfigureOptions): Promise<void> {
  if (opts.fetch) {
    customFetch = opts.fetch;
    proxyInitDone = true;
    return;
  }
  if (opts.proxy) {
    try {
      const { ProxyAgent } = await import("undici");
      const dispatcher = new ProxyAgent(opts.proxy);
      customFetch = (input, init?) =>
        globalThis.fetch(input, { ...init, dispatcher } as any);
      proxyInitDone = true;
    } catch {
      throw new Error(
        "undici is required for proxy support: npm install undici",
      );
    }
  }
}

/** Set the default space ID injected into requests. */
export function setSpaceId(id: string) {
  defaultSpaceId = id;
}

/** Get the current default space ID. */
export function getSpaceId(): string {
  return defaultSpaceId;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ArkeError extends Error {
  status: number;
  requestId?: string;
  code?: string;
  details?: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    requestId?: string,
    code?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ArkeError";
    this.status = status;
    this.requestId = requestId;
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Core request
// ---------------------------------------------------------------------------

type RequestOpts = {
  json?: any;
  params?: Record<string, string>;
};

async function request(method: string, path: string, opts?: RequestOpts) {
  const url = new URL(path, baseUrl);

  // Auto-inject space_id into query params for GET requests
  if (defaultSpaceId && method === "GET" && !url.searchParams.has("space_id")) {
    url.searchParams.set("space_id", defaultSpaceId);
  }

  if (opts?.params)
    for (const [k, v] of Object.entries(opts.params))
      url.searchParams.set(k, v);

  // Auto-inject space_id into body for mutating requests
  let body: string | undefined;
  if (opts?.json) {
    const defaults: Record<string, string> = {};
    if (defaultSpaceId && !opts.json.space_id) defaults.space_id = defaultSpaceId;
    const payload = Object.keys(defaults).length > 0
      ? { ...defaults, ...opts.json }
      : opts.json;
    body = JSON.stringify(payload);
  }

  await ensureProxy();
  const doFetch = customFetch ?? globalThis.fetch;
  const res = await doFetch(url, { method, headers: defaultHeaders, body });

  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as any;
    throw new ArkeError(
      res.status,
      errBody?.error?.message ?? res.statusText,
      errBody?.error?.request_id ?? res.headers.get("x-request-id") ?? undefined,
      errBody?.error?.code,
      errBody?.error?.details,
    );
  }

  if (res.status === 204) return undefined;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

// ---------------------------------------------------------------------------
// HTTP methods
// ---------------------------------------------------------------------------

export const get = (path: string, opts?: { params?: Record<string, string> }) =>
  request("GET", path, opts);

/**
 * Raw GET — returns the Response object directly (for binary content, streaming, etc.).
 * Uses the same auth and proxy config as other SDK methods.
 */
export async function rawGet(path: string, params?: Record<string, string>): Promise<Response> {
  const url = new URL(path, baseUrl);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  await ensureProxy();
  const doFetch = customFetch ?? globalThis.fetch;
  const res = await doFetch(url, { method: "GET", headers: defaultHeaders });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as any;
    throw new ArkeError(
      res.status,
      errBody?.error?.message ?? res.statusText,
      errBody?.error?.request_id ?? res.headers.get("x-request-id") ?? undefined,
      errBody?.error?.code,
      errBody?.error?.details,
    );
  }
  return res;
}

export const post = (path: string, json?: any) =>
  request("POST", path, { json });

/**
 * Raw POST — sends a binary/non-JSON body and returns the parsed JSON response.
 * Uses the same auth and proxy config as other SDK methods.
 */
export async function rawPost(
  path: string,
  body: Buffer | Uint8Array | string | ReadableStream,
  opts?: { params?: Record<string, string>; contentType?: string },
): Promise<any> {
  const url = new URL(path, baseUrl);
  if (opts?.params) {
    for (const [k, v] of Object.entries(opts.params)) url.searchParams.set(k, v);
  }
  await ensureProxy();
  const doFetch = customFetch ?? globalThis.fetch;
  const headers: Record<string, string> = {
    Authorization: defaultHeaders.Authorization,
  };
  if (opts?.contentType) headers["Content-Type"] = opts.contentType;
  const res = await doFetch(url, { method: "POST", headers, body });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as any;
    throw new ArkeError(
      res.status,
      errBody?.error?.message ?? res.statusText,
      errBody?.error?.request_id ?? res.headers.get("x-request-id") ?? undefined,
      errBody?.error?.code,
      errBody?.error?.details,
    );
  }
  if (res.status === 204) return undefined;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

export const put = (path: string, json?: any) =>
  request("PUT", path, { json });

export const patch = (path: string, json?: any) =>
  request("PATCH", path, { json });

export const del = (path: string) => request("DELETE", path);

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * Async generator that transparently paginates through a list endpoint.
 *
 * Yields individual items from each page. The collection key is auto-detected
 * from the response (the first array-valued key that isn't "cursor").
 *
 * @example
 *   for await (const entity of paginate('/entities', { limit: '50' })) {
 *     console.log(entity.id);
 *   }
 */
export async function* paginate<T = any>(
  path: string,
  params?: Record<string, string>,
): AsyncGenerator<T> {
  let cursor: string | undefined;
  do {
    const p = { ...params, ...(cursor ? { cursor } : {}) };
    const res = (await get(path, { params: p })) as Record<string, unknown>;
    if (!res || typeof res !== "object") return;

    // Find the array of items — it's the non-cursor array field
    const items = Object.values(res).find(
      (v) => Array.isArray(v),
    ) as T[] | undefined;

    if (!items || items.length === 0) return;
    yield* items;
    cursor = (res.cursor as string) ?? undefined;
  } while (cursor);
}
