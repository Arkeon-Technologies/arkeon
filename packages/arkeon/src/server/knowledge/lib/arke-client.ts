// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Arkeon SDK wrapper for the knowledge extraction pipeline.
 * Configures the SDK with a service API key at runtime.
 */

export {
  get,
  post,
  put,
  patch,
  del,
  paginate,
  rawGet,
  rawPost,
  setSpaceId,
  getSpaceId,
  ArkeError,
  configure,
} from "@arkeon-technologies/sdk";

import { get, post, put, del, rawGet, rawPost, configure } from "@arkeon-technologies/sdk";

/**
 * Override the SDK's API key and base URL at runtime by wrapping fetch.
 * The SDK reads ARKE_API_URL at import time as a const, so if the env var
 * wasn't set before the SDK loaded, we need to rewrite URLs in the fetch wrapper.
 */
export async function setServiceKey(key: string): Promise<void> {
  const targetBaseUrl = process.env.ARKE_API_URL ?? "http://localhost:8000";
  // The SDK may have captured a stale base URL at import time
  const sdkBaseUrl = "http://localhost:8000";

  await configure({
    fetch: ((input: any, init?: any) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `ApiKey ${key}`);

      // Rewrite URL if the SDK is using a stale base URL
      let url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (targetBaseUrl !== sdkBaseUrl && url.startsWith(sdkBaseUrl)) {
        url = targetBaseUrl + url.slice(sdkBaseUrl.length);
      }

      return globalThis.fetch(url, { ...init, headers });
    }) as typeof fetch,
  });
}

// --- Convenience helpers ---

export async function getEntity(id: string, view?: "expanded"): Promise<any> {
  const params: Record<string, string> = {};
  if (view) params.view = view;
  const data = (await get(`/entities/${id}`, { params })) as any;
  return data?.entity ?? data;
}

export async function createEntity(opts: {
  type: string;
  properties: Record<string, unknown>;
  space_id?: string;
  read_level?: number;
  write_level?: number;
  permissions?: Array<{ grantee_type: string; grantee_id: string; role: string }>;
}): Promise<string> {
  const data = (await post("/entities", opts)) as any;
  return data?.id ?? data?.entity?.id;
}

export async function updateEntity(
  id: string,
  opts: { ver: number; properties?: Record<string, unknown>; note?: string },
): Promise<any> {
  return put(`/entities/${id}`, opts);
}

export async function deleteEntity(id: string): Promise<void> {
  await del(`/entities/${id}`);
}

export async function createRelationship(
  sourceId: string,
  opts: {
    predicate: string;
    target_id: string;
    properties?: Record<string, unknown>;
    read_level?: number;
    space_id?: string;
  },
): Promise<string> {
  const data = (await post(
    `/entities/${sourceId}/relationships`,
    opts,
  )) as any;
  return data?.id ?? data?.relationship?.id;
}

export async function search(
  q: string,
  opts?: { space_id?: string; filter?: string; limit?: number },
): Promise<any[]> {
  const params: Record<string, string> = { q };
  if (opts?.space_id) params.space_id = opts.space_id;
  if (opts?.filter) params.filter = opts.filter;
  if (opts?.limit) params.limit = String(opts.limit);
  const data = (await get("/search", { params })) as any;
  return data?.results ?? [];
}

export async function getEntityContent(
  entityId: string,
  key: string,
): Promise<string> {
  const data = await get(`/entities/${entityId}/content`, {
    params: { key },
  });
  return typeof data === "string" ? data : JSON.stringify(data);
}

/**
 * Fetch entity content as raw bytes (for binary formats like PDF, images).
 * Uses the SDK's configured fetch (same auth as all other SDK calls)
 * with rawGet() to get the Response object directly.
 */
export async function getEntityContentBytes(
  entityId: string,
  key: string,
): Promise<Buffer> {
  const res = await rawGet(`/entities/${entityId}/content`, { key });
  return Buffer.from(await res.arrayBuffer());
}

export async function transferOwnership(
  entityId: string,
  newOwnerId: string,
): Promise<void> {
  await put(`/entities/${entityId}/owner`, { owner_id: newOwnerId });
}

export async function getEntityPermissions(
  entityId: string,
): Promise<{
  owner_id: string;
  permissions: Array<{ grantee_type: string; grantee_id: string; role: string }>;
}> {
  const data = (await get(`/entities/${entityId}/permissions`)) as any;
  return {
    owner_id: data?.owner_id ?? "",
    permissions: data?.permissions ?? [],
  };
}

/**
 * Upload binary content to an entity via the API.
 * Uses the SDK's configured auth and proxy — no env var reads.
 */
export async function uploadEntityContent(
  entityId: string,
  key: string,
  ver: number,
  body: Buffer | Uint8Array,
  contentType: string,
): Promise<{ cid: string; size: number; ver: number }> {
  const data = await rawPost(`/entities/${entityId}/content`, body, {
    params: { key, ver: String(ver) },
    contentType,
  });
  return data as { cid: string; size: number; ver: number };
}
