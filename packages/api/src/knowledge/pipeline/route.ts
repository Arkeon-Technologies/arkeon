/**
 * Content router: produces normalized text from an entity by combining
 * inline properties with file content fetched via the API.
 */

import { getEntityContent } from "../lib/arke-client";
import type { ContentResult } from "../lib/types";

export interface ContentHandler {
  canHandle(mimeType: string): boolean;
  handle(entityId: string, key: string): Promise<string>;
}

const textHandler: ContentHandler = {
  canHandle(mimeType: string): boolean {
    return mimeType.startsWith("text/");
  },
  async handle(entityId: string, key: string): Promise<string> {
    return getEntityContent(entityId, key);
  },
};

const handlers: ContentHandler[] = [textHandler];

interface ContentEntry {
  key: string;
  cid: string;
  content_type: string;
  size: number;
}

function getInlineText(entity: any): string {
  const parts: string[] = [];
  const props = entity.properties ?? {};

  if (typeof props.label === "string" && props.label) parts.push(props.label);
  if (typeof entity.note === "string" && entity.note) parts.push(entity.note);

  for (const [key, value] of Object.entries(props)) {
    if (key === "label") continue;
    if (key === "content" && typeof value === "object") continue;
    if (typeof value === "string" && value.trim().length > 0) {
      parts.push(value);
    }
  }

  return parts.join("\n\n");
}

function getContentEntries(entity: any): ContentEntry[] {
  const props = entity.properties ?? {};
  const contentMap = props.content;

  if (!contentMap || typeof contentMap !== "object" || typeof contentMap === "string") {
    return [];
  }

  const entries: ContentEntry[] = [];
  for (const [key, value] of Object.entries(contentMap)) {
    const entry = value as any;
    if (entry && typeof entry === "object" && entry.cid && entry.content_type) {
      entries.push({
        key,
        cid: entry.cid,
        content_type: entry.content_type,
        size: entry.size ?? 0,
      });
    }
  }

  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

export async function routeContent(entity: any): Promise<ContentResult> {
  const entityId = entity.id;
  const inlineText = getInlineText(entity);
  const entries = getContentEntries(entity);

  let fileText = "";
  let mimeType: string | undefined;
  let sourceKey: string | undefined;

  for (const entry of entries) {
    const handler = handlers.find((h) => h.canHandle(entry.content_type));
    if (!handler) continue;

    try {
      const text = await handler.handle(entityId, entry.key);
      if (text && text.trim().length > 0) {
        fileText = text;
        mimeType = entry.content_type;
        sourceKey = entry.key;
        break;
      }
    } catch (err) {
      console.warn(`[knowledge:route] Failed to fetch content for ${entityId}/${entry.key}:`, err instanceof Error ? err.message : err);
    }
  }

  // If no handler matched but content entries exist, pass through the MIME type
  // and source key so ingest.ts can route to format-specific handlers (PDF, DOCX, etc.)
  if (!mimeType && entries.length > 0) {
    mimeType = entries[0].content_type;
    sourceKey = entries[0].key;
  }

  const parts = [inlineText, fileText].filter((p) => p.trim().length > 0);
  const text = parts.join("\n\n---\n\n");

  return { text, mimeType, sourceKey };
}
