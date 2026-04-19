// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * LLM wrapper using the OpenAI SDK.
 * Supports JSON mode (for extract pipeline) and tool calling.
 * Works with any OpenAI-compatible API (Anthropic, OpenAI, local models).
 */

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from "openai/resources/chat/completions";

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
}

export interface LlmUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
}

export interface ChatJsonResult<T> {
  data: T;
  usage: LlmUsage;
}

export interface ChatToolResult {
  message: OpenAI.Chat.Completions.ChatCompletionMessage;
  usage: LlmUsage;
}

/**
 * Attempt to repair truncated JSON by closing unclosed arrays/objects.
 * Works by scanning the string to track the nesting stack, trimming the
 * last incomplete value, and appending the necessary closing brackets.
 * Returns the parsed object on success, or null if unrecoverable.
 */
export function repairTruncatedJson(text: string): unknown | null {
  let trimmed = text.trimEnd();

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }

  if (inString) {
    // We're inside a string — the text was truncated mid-value.
    // Trim back to the last complete element boundary: a closing } or ]
    // that finishes a complete object/array, or a comma between elements.
    // Simply trimming to lastIndexOf('"') can land on an opening quote.
    let cutPoint = -1;
    for (let i = trimmed.length - 1; i >= 0; i--) {
      const ch = trimmed[i];
      if (ch === "}" || ch === "]") { cutPoint = i + 1; break; }
      if (ch === ",") { cutPoint = i; break; }
    }
    if (cutPoint > 0) {
      trimmed = trimmed.slice(0, cutPoint);
    }
  }

  trimmed = trimmed.replace(/[,:\s]+$/, "");

  // Re-scan after trimming
  stack.length = 0;
  inString = false;
  escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }

  const repaired = trimmed + stack.reverse().join("");

  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

export class LlmClient {
  private client: OpenAI;
  private model: string;
  private maxTokens: number;

  constructor(config: LlmConfig) {
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
      timeout: 180_000,
    });
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 4096;
  }

  /**
   * Single-shot JSON mode call. Returns parsed JSON of type T.
   */
  async chatJson<T>(
    systemPrompt: string,
    userMessage: string,
    opts?: { maxTokens?: number; signal?: AbortSignal },
  ): Promise<ChatJsonResult<T>> {
    return this._chatJsonInternal<T>(systemPrompt, userMessage, opts);
  }

  /**
   * Single-shot JSON mode call with multimodal content (text + images).
   * Images are passed as data URIs in image_url content parts.
   */
  async chatVision<T>(
    systemPrompt: string,
    content: Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >,
    opts?: { maxTokens?: number; signal?: AbortSignal },
  ): Promise<ChatJsonResult<T>> {
    return this._chatJsonInternal<T>(systemPrompt, content, opts);
  }

  /**
   * Shared JSON mode implementation for both text and multimodal calls.
   */
  private async _chatJsonInternal<T>(
    systemPrompt: string,
    userContent: string | Array<{ type: string; text?: string; image_url?: { url: string } }>,
    opts?: { maxTokens?: number; signal?: AbortSignal },
  ): Promise<ChatJsonResult<T>> {
    const maxTokens = opts?.maxTokens ?? this.maxTokens;

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: maxTokens,
    } as any, { signal: opts?.signal });

    const raw = response.choices[0]?.message?.content;
    const finishReason = response.choices[0]?.finish_reason;
    const body = raw && raw.trim().length > 0 ? raw : "{}";
    const usage: LlmUsage = {
      model: this.model,
      tokensIn: response.usage?.prompt_tokens ?? 0,
      tokensOut: response.usage?.completion_tokens ?? 0,
    };

    if (finishReason === "length") {
      const repaired = repairTruncatedJson(body);
      if (repaired !== null) {
        console.warn(`[llm] Response truncated (finish_reason=length, model=${this.model}, tokens_out=${usage.tokensOut}) — parsed partial result`);
        return { data: repaired as T, usage };
      }
      throw new Error(`LLM response truncated and unrecoverable (finish_reason=length, model=${this.model}, tokens_out=${usage.tokensOut}, ${body.length} chars)`);
    }

    try {
      return { data: JSON.parse(body) as T, usage };
    } catch (err) {
      const preview = body.slice(0, 200);
      throw new Error(`Failed to parse LLM JSON (finish_reason=${finishReason}, ${body.length} chars): ${preview}...`);
    }
  }

  /**
   * Chat completion with tool calling support.
   */
  async chatWithTools(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[],
    opts?: {
      toolChoice?: ChatCompletionToolChoiceOption;
      maxTokens?: number;
      signal?: AbortSignal;
    },
  ): Promise<ChatToolResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? (opts?.toolChoice ?? "auto") : undefined,
      max_completion_tokens: opts?.maxTokens ?? this.maxTokens,
    } as any, { signal: opts?.signal });

    const message = response.choices[0]?.message;
    if (!message) {
      throw new Error("No message in LLM response");
    }

    const usage: LlmUsage = {
      model: this.model,
      tokensIn: response.usage?.prompt_tokens ?? 0,
      tokensOut: response.usage?.completion_tokens ?? 0,
    };

    return { message, usage };
  }
}

export type { ChatCompletionMessageParam, ChatCompletionTool };
