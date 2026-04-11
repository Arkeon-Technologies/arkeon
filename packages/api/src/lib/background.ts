// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

export function backgroundTask(promise: Promise<unknown>) {
  promise.catch((err) => console.error("[background]", err));
}
