const baseUrl = process.env.ARKE_API_URL ?? "http://localhost:8000";
const apiKey = process.env.ARKE_API_KEY ?? "";
const defaultHeaders: Record<string, string> = {
  Authorization: `ApiKey ${apiKey}`,
  "Content-Type": "application/json",
};

export class ArkeError extends Error {
  status: number;
  requestId?: string;
  code?: string;

  constructor(
    status: number,
    message: string,
    requestId?: string,
    code?: string,
  ) {
    super(message);
    this.name = "ArkeError";
    this.status = status;
    this.requestId = requestId;
    this.code = code;
  }
}

async function request(
  method: string,
  path: string,
  opts?: { json?: any; params?: Record<string, string> },
) {
  const url = new URL(path, baseUrl);
  if (opts?.params)
    for (const [k, v] of Object.entries(opts.params))
      url.searchParams.set(k, v);

  const res = await fetch(url, {
    method,
    headers: defaultHeaders,
    body: opts?.json ? JSON.stringify(opts.json) : undefined,
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as any;
    throw new ArkeError(
      res.status,
      body?.error?.message ?? res.statusText,
      body?.error?.request_id,
      body?.error?.code,
    );
  }

  if (res.status === 204) return undefined;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

export const get = (
  path: string,
  opts?: { params?: Record<string, string> },
) => request("GET", path, opts);

export const post = (path: string, json?: any) =>
  request("POST", path, { json });

export const put = (path: string, json?: any) =>
  request("PUT", path, { json });

export const del = (path: string) => request("DELETE", path);
