// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Lightweight API client for CLI commands that talk directly to a
 * specific Arkeon instance (bypassing the global config/credentials).
 *
 * Used by repo commands (init, diff, add, rm) which resolve their own
 * API URL and API key from .arkeon/state.json + credential store.
 */

export async function apiGet<T>(apiUrl: string, path: string, apiKey: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: { accept: "application/json", authorization: `ApiKey ${apiKey}` },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(payload?.error?.message ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export async function apiPost<T>(apiUrl: string, path: string, apiKey: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `ApiKey ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(payload?.error?.message ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export async function apiPut<T>(apiUrl: string, path: string, apiKey: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `ApiKey ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(payload?.error?.message ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export async function apiDelete(apiUrl: string, path: string, apiKey: string): Promise<void> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "DELETE",
    headers: { authorization: `ApiKey ${apiKey}` },
  });
  if (!response.ok && response.status !== 404) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(payload?.error?.message ?? `${response.status} ${response.statusText}`);
  }
}
