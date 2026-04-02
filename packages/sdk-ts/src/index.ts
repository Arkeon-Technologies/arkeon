const baseUrl = process.env.ARKE_API_URL ?? "http://localhost:8000";
const apiKey = process.env.ARKE_API_KEY ?? "";
let defaultArkeId = process.env.ARKE_ID ?? "";

const defaultHeaders: Record<string, string> = {
  Authorization: `ApiKey ${apiKey}`,
  "Content-Type": "application/json",
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Set the default arke ID injected into requests. */
export function setArkeId(id: string) {
  defaultArkeId = id;
}

/** Get the current default arke ID. */
export function getArkeId(): string {
  return defaultArkeId;
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

  // Auto-inject arke_id into query params for GET requests
  if (defaultArkeId && method === "GET" && !url.searchParams.has("arke_id")) {
    url.searchParams.set("arke_id", defaultArkeId);
  }

  if (opts?.params)
    for (const [k, v] of Object.entries(opts.params))
      url.searchParams.set(k, v);

  // Auto-inject arke_id into body for mutating requests
  let body: string | undefined;
  if (opts?.json) {
    const payload =
      defaultArkeId && !opts.json.arke_id
        ? { arke_id: defaultArkeId, ...opts.json }
        : opts.json;
    body = JSON.stringify(payload);
  }

  const res = await fetch(url, { method, headers: defaultHeaders, body });

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

export const post = (path: string, json?: any) =>
  request("POST", path, { json });

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
