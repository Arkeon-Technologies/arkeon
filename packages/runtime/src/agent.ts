// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile, mkdir, stat, access } from "node:fs/promises";
import { dirname, extname, isAbsolute, join } from "node:path";

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { APIError, AuthenticationError, BadRequestError, PermissionDeniedError } from "openai/error";

import { Sandbox, type SandboxConfig } from "./sandbox.js";
import { LlmClient, type LlmConfig } from "./llm.js";

export interface AgentConfig {
  /** Agent name (for logging) */
  name: string;
  /** System prompt defining the agent's role and behavior */
  systemPrompt: string;
  /** LLM provider configuration */
  llm: LlmConfig;
  /** Sandbox configuration */
  sandbox: SandboxConfig;
  /** Max iterations of the agent loop before force-stopping (default: 50) */
  maxIterations?: number;
  /** Callback for logging agent activity */
  onLog?: (entry: LogEntry) => void;
  /** File path containing the final JSON result written by the worker */
  doneFilePath?: string;
  /** File path created by the shell `done` command to signal completion */
  doneSignalPath?: string;
}

export interface LogEntry {
  timestamp: string;
  type:
    | "system"
    | "llm_request"
    | "llm_response"
    | "tool_call"
    | "tool_result"
    | "error"
    | "done";
  content: string;
  detail?: unknown;
}

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  llmCalls: number;
  toolCalls: number;
}

export interface AgentResult {
  success: boolean;
  result: Record<string, unknown> | null;
  iterations: number;
  log: LogEntry[];
  usage: UsageStats;
}

const MAX_TOOL_OUTPUT_LENGTH = 20_000;

function truncate(s: string, max: number = MAX_TOOL_OUTPUT_LENGTH, logOnly: boolean = false): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2) - 50;
  const note = logOnly
    ? `\n\n... [${s.length - max} characters hidden from log, full result sent to model] ...\n\n`
    : `\n\n... [truncated ${s.length - max} characters] ...\n\n`;
  return (
    s.slice(0, half) +
    note +
    s.slice(-half)
  );
}

export class Agent {
  private name: string;
  private systemPrompt: string;
  private llm: LlmClient;
  private sandbox: Sandbox;
  private maxIterations: number;
  private log: LogEntry[] = [];
  private onLog?: (entry: LogEntry) => void;
  private doneFilePath: string;
  private doneSignalPath: string;

  constructor(config: AgentConfig) {
    this.name = config.name;
    this.systemPrompt = config.systemPrompt;
    this.llm = new LlmClient(config.llm);
    this.sandbox = new Sandbox(config.sandbox);
    this.maxIterations = config.maxIterations ?? 50;
    this.onLog = config.onLog;
    this.doneFilePath = config.doneFilePath ?? join(config.sandbox.workspaceDir, ".arke-done.json");
    this.doneSignalPath = config.doneSignalPath ?? join(config.sandbox.workspaceDir, ".arke-done.signal");
  }

  /** Return a snapshot of the log accumulated so far (useful after timeout). */
  getLog(): LogEntry[] {
    return [...this.log];
  }

  private emit(entry: Omit<LogEntry, "timestamp">): void {
    const full: LogEntry = { ...entry, timestamp: new Date().toISOString() };
    this.log.push(full);
    this.onLog?.(full);
  }

  /**
   * Run the agent with a prompt. Returns when the agent signals completion
   * via the shell helper, hits the iteration limit, or the abort signal fires.
   */
  async run(prompt: string, signal?: AbortSignal): Promise<AgentResult> {
    this.log = [];
    this.emit({ type: "system", content: `Agent "${this.name}" starting` });

    // Kill the sandbox child process immediately when aborted
    if (signal) {
      signal.addEventListener("abort", () => this.sandbox.kill(), { once: true });
    }

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: prompt },
    ];

    let iterations = 0;
    const usage: UsageStats = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      llmCalls: 0,
      toolCalls: 0,
    };

    while (iterations < this.maxIterations) {
      if (signal?.aborted) {
        this.emit({ type: "error", content: "Aborted" });
        return {
          success: false,
          result: { error: "Aborted" },
          iterations,
          log: this.log,
          usage,
        };
      }

      iterations++;
      this.emit({
        type: "llm_request",
        content: `Iteration ${iterations}/${this.maxIterations}`,
      });

      let response;
      try {
        response = await this.llm.chat(messages);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isPermanent =
          err instanceof AuthenticationError ||
          err instanceof BadRequestError ||
          err instanceof PermissionDeniedError;
        const statusInfo = err instanceof APIError ? ` (status ${err.status})` : "";
        const retryNote = !isPermanent && err instanceof APIError
          ? " (retries exhausted)"
          : "";
        this.emit({
          type: "error",
          content: `LLM error${statusInfo}${retryNote}: ${msg}`,
          detail: err instanceof APIError
            ? { status: err.status, type: err.type, code: err.code, permanent: isPermanent }
            : undefined,
        });
        return {
          success: false,
          result: { error: `LLM error${statusInfo}: ${msg}` },
          iterations,
          log: this.log,
          usage,
        };
      }

      // Accumulate token usage from this LLM call
      usage.llmCalls++;
      if (response.usage) {
        usage.inputTokens += response.usage.prompt_tokens;
        usage.outputTokens += response.usage.completion_tokens;
        usage.totalTokens += response.usage.total_tokens;
      }

      const choice = response.choices[0];
      if (!choice) {
        this.emit({ type: "error", content: "No response from LLM" });
        return {
          success: false,
          result: { error: "No response from LLM" },
          iterations,
          log: this.log,
          usage,
        };
      }

      const assistantMessage = choice.message;

      // Log any text content
      if (assistantMessage.content) {
        this.emit({
          type: "llm_response",
          content: assistantMessage.content,
        });
      }

      // Add assistant message to history
      messages.push(assistantMessage);

      // Workers must explicitly signal completion via the shell `done` command.
      // Plain text output alone is not considered a successful completion.
      if (
        !assistantMessage.tool_calls ||
        assistantMessage.tool_calls.length === 0
      ) {
        const errMsg =
          assistantMessage.content
            ? `Agent stopped without calling done: ${assistantMessage.content}`
            : "Agent stopped without calling done";
        this.emit({
          type: "error",
          content: errMsg,
        });
        return {
          success: false,
          result: { error: errMsg },
          iterations,
          log: this.log,
          usage,
        };
      }

      // Count tool calls for this iteration
      usage.toolCalls += assistantMessage.tool_calls.length;

      // Execute each tool call
      for (const toolCall of assistantMessage.tool_calls) {
        const fnName = toolCall.function.name;
        let args: Record<string, unknown>;
        try {
          const raw = toolCall.function.arguments;
          args = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch {
          const errMsg = `Invalid JSON in tool arguments: ${toolCall.function.arguments}`;
          this.emit({ type: "error", content: errMsg });
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: errMsg,
          });
          continue;
        }

        this.emit({
          type: "tool_call",
          content: `${fnName}(${JSON.stringify(args).slice(0, 200)})`,
          detail: { name: fnName, args },
        });

        let result: string;
        // If a tool needs to inject extra messages (e.g. image content), they go here
        let followUpMessage: ChatCompletionMessageParam | null = null;

        switch (fnName) {
          case "shell":
            result = await this.handleShell(
              args.command as string,
              args.timeout_ms as number | undefined,
            );
            if (await this.doneSignalExists()) {
              const doneFile = await this.readDoneFileResult();
              if (!doneFile.ok) {
                result += `\n[done error] ${doneFile.error}`;
                break;
              }

              this.emit({
                type: "done",
                content: JSON.stringify(doneFile.result),
                detail: doneFile.result,
              });
              return {
                success: true,
                result: doneFile.result,
                iterations,
                log: this.log,
                usage,
              };
            }
            break;
          case "read_file":
            result = await this.handleReadFile(args.path as string);
            break;
          case "write_file":
            result = await this.handleWriteFile(
              args.path as string,
              args.content as string,
            );
            break;
          case "view_image": {
            const imageResult = await this.handleViewImage(args.path as string);
            result = imageResult.text;
            followUpMessage = imageResult.imageMessage;
            break;
          }
          default:
            result = `Unknown tool: ${fnName}`;
        }

        this.emit({
          type: "tool_result",
          content: truncate(result, 500, true),
        });

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: truncate(result),
        });

        // Inject image content as a follow-up user message (Chat Completions API
        // doesn't support images in tool results, so we append a user message)
        if (followUpMessage) {
          messages.push(followUpMessage);
        }
      }
    }

    this.emit({
      type: "error",
      content: `Reached max iterations (${this.maxIterations})`,
    });
    return {
      success: false,
      result: { error: `Reached max iterations (${this.maxIterations})` },
      iterations,
      log: this.log,
      usage,
    };
  }

  private async handleShell(
    command: string,
    timeoutMs?: number,
  ): Promise<string> {
    const timeout = Math.min(timeoutMs ?? 30_000, 300_000);
    const result = await this.sandbox.exec(command, timeout);

    let output = "";
    if (result.stdout) output += result.stdout;
    if (result.stderr)
      output += (output ? "\n" : "") + `[stderr] ${result.stderr}`;
    if (result.exitCode !== 0) {
      output += (output ? "\n" : "") + `[exit code: ${result.exitCode}]`;
    }
    return output || "(no output)";
  }

  private async handleReadFile(path: string): Promise<string> {
    const resolved = this.resolvePath(path);
    try {
      return await readFile(resolved, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error reading file: ${msg}`;
    }
  }

  private async handleWriteFile(
    path: string,
    content: string,
  ): Promise<string> {
    const resolved = this.resolvePath(path);
    try {
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content, "utf-8");
      return `Written ${content.length} bytes to ${path}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error writing file: ${msg}`;
    }
  }

  private async handleViewImage(
    path: string,
  ): Promise<{ text: string; imageMessage: ChatCompletionMessageParam | null }> {
    const resolved = this.resolvePath(path);
    try {
      const ext = extname(resolved).toLowerCase();
      const mimeMap: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
      };
      const mime = mimeMap[ext];
      if (!mime) {
        return {
          text: `Unsupported image format: ${ext}. Supported: png, jpg, gif, webp`,
          imageMessage: null,
        };
      }

      const info = await stat(resolved);
      const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
      if (info.size > MAX_IMAGE_SIZE) {
        return {
          text: `Image too large: ${(info.size / 1024 / 1024).toFixed(1)}MB (max 10MB). Use Pillow to resize first.`,
          imageMessage: null,
        };
      }

      const buffer = await readFile(resolved);
      const base64 = buffer.toString("base64");
      const dataUrl = `data:${mime};base64,${base64}`;
      const sizeKB = (info.size / 1024).toFixed(1);

      return {
        text: `Image loaded: ${path} (${sizeKB}KB, ${mime}). The image is shown below.`,
        imageMessage: {
          role: "user",
          content: [
            { type: "text", text: `[view_image result for ${path}]` },
            { type: "image_url", image_url: { url: dataUrl, detail: "auto" } },
          ],
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { text: `Error reading image: ${msg}`, imageMessage: null };
    }
  }

  private async readDoneFileResult(): Promise<
    { ok: true; result: Record<string, unknown> } | { ok: false; error: string }
  > {
    try {
      const raw = await readFile(this.doneFilePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
          ok: false,
          error:
            `Invalid $ARKE_DONE_FILE content at ${this.doneFilePath}: expected a JSON object.`,
        };
      }

      return { ok: true, result: parsed as Record<string, unknown> };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `Could not read final result from $ARKE_DONE_FILE at ${this.doneFilePath}: ${msg}`,
      };
    }
  }

  private async doneSignalExists(): Promise<boolean> {
    try {
      await access(this.doneSignalPath);
      return true;
    } catch {
      return false;
    }
  }

  private resolvePath(path: string): string {
    if (isAbsolute(path)) {
      if (!path.startsWith(this.sandbox.workspace)) {
        return join(this.sandbox.workspace, path);
      }
      return path;
    }
    return join(this.sandbox.workspace, path);
  }
}
