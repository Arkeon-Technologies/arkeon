// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface Actor {
  id: string;
  apiKeyId: string;
  keyPrefix: string;
  label: string | null;
  maxReadLevel: number;
  maxWriteLevel: number;
  isAdmin: boolean;
  canPublishPublic: boolean;
}

export interface AppBindings {
  Variables: {
    actor: Actor | null;
    requestId: string;
  };
}
