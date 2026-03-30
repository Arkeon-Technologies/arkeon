import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

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

export interface AgentResult {
  success: boolean;
  summary: string | null;
  iterations: number;
  log: LogEntry[];
}

const MAX_TOOL_OUTPUT_LENGTH = 20_000;

function truncate(s: string, max: number = MAX_TOOL_OUTPUT_LENGTH): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2) - 50;
  return (
    s.slice(0, half) +
    `\n\n... [truncated ${s.length - max} characters] ...\n\n` +
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

  constructor(config: AgentConfig) {
    this.name = config.name;
    this.systemPrompt = config.systemPrompt;
    this.llm = new LlmClient(config.llm);
    this.sandbox = new Sandbox(config.sandbox);
    this.maxIterations = config.maxIterations ?? 50;
    this.onLog = config.onLog;
  }

  private emit(entry: Omit<LogEntry, "timestamp">): void {
    const full: LogEntry = { ...entry, timestamp: new Date().toISOString() };
    this.log.push(full);
    this.onLog?.(full);
  }

  /**
   * Run the agent with a prompt. Returns when the agent calls `done`
   * or hits the iteration limit.
   */
  async run(prompt: string): Promise<AgentResult> {
    this.log = [];
    this.emit({ type: "system", content: `Agent "${this.name}" starting` });

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: prompt },
    ];

    let iterations = 0;

    while (iterations < this.maxIterations) {
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
        this.emit({ type: "error", content: `LLM error: ${msg}` });
        return {
          success: false,
          summary: `LLM error: ${msg}`,
          iterations,
          log: this.log,
        };
      }

      const choice = response.choices[0];
      if (!choice) {
        this.emit({ type: "error", content: "No response from LLM" });
        return {
          success: false,
          summary: "No response from LLM",
          iterations,
          log: this.log,
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

      // If no tool calls, the agent is done (or stuck)
      if (
        !assistantMessage.tool_calls ||
        assistantMessage.tool_calls.length === 0
      ) {
        this.emit({
          type: "done",
          content:
            assistantMessage.content ?? "Agent stopped without calling done",
        });
        return {
          success: true,
          summary: assistantMessage.content,
          iterations,
          log: this.log,
        };
      }

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

        switch (fnName) {
          case "shell":
            result = await this.handleShell(
              args.command as string,
              args.timeout_ms as number | undefined,
            );
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
          case "done": {
            const summary = (args.summary as string) ?? "Done";
            this.emit({ type: "done", content: summary });
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: "Task complete.",
            });
            return {
              success: true,
              summary,
              iterations,
              log: this.log,
            };
          }
          default:
            result = `Unknown tool: ${fnName}`;
        }

        this.emit({
          type: "tool_result",
          content: truncate(result, 500),
        });

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: truncate(result),
        });
      }
    }

    this.emit({
      type: "error",
      content: `Reached max iterations (${this.maxIterations})`,
    });
    return {
      success: false,
      summary: `Reached max iterations (${this.maxIterations})`,
      iterations,
      log: this.log,
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
