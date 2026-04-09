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

export class LlmClient {
  private client: OpenAI;
  private model: string;
  private maxTokens: number;

  constructor(config: LlmConfig) {
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
      timeout: 60_000,
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
    opts?: { maxTokens?: number },
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
    opts?: { maxTokens?: number },
  ): Promise<ChatJsonResult<T>> {
    return this._chatJsonInternal<T>(systemPrompt, content, opts);
  }

  /**
   * Shared JSON mode implementation for both text and multimodal calls.
   */
  private async _chatJsonInternal<T>(
    systemPrompt: string,
    userContent: string | Array<{ type: string; text?: string; image_url?: { url: string } }>,
    opts?: { maxTokens?: number },
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
    } as any);

    const raw = response.choices[0]?.message?.content;
    const finishReason = response.choices[0]?.finish_reason;
    const body = raw && raw.trim().length > 0 ? raw : "{}";
    const usage: LlmUsage = {
      model: this.model,
      tokensIn: response.usage?.prompt_tokens ?? 0,
      tokensOut: response.usage?.completion_tokens ?? 0,
    };

    if (finishReason === "length") {
      throw new Error(`LLM response truncated (finish_reason=length, model=${this.model}, tokens_out=${usage.tokensOut}). Increase max_tokens or reduce input size.`);
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
    },
  ): Promise<ChatToolResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? (opts?.toolChoice ?? "auto") : undefined,
      max_completion_tokens: opts?.maxTokens ?? this.maxTokens,
    } as any);

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
