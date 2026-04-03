import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

export interface LlmConfig {
  /** OpenAI-compatible API base URL */
  baseUrl: string;
  /** API key for the provider */
  apiKey: string;
  /** Model identifier */
  model: string;
  /** Max tokens for completion (default: 4096) */
  maxTokens?: number;
}

/** The tools available to agents in the sandbox */
export const AGENT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "shell",
      description:
        "Execute a shell command in the sandbox. The command runs in /bin/bash in the agent's workspace directory. Use this for anything: running scripts, installing packages, processing files, calling APIs with curl, etc.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command to execute",
          },
          timeout_ms: {
            type: "number",
            description:
              "Timeout in milliseconds (default: 30000, max: 300000)",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file from the workspace. Returns the file contents as a string.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "File path relative to the workspace directory, or absolute path within the workspace",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write content to a file in the workspace. Creates parent directories if needed.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "File path relative to the workspace directory, or absolute path within the workspace",
          },
          content: {
            type: "string",
            description: "The content to write to the file",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description:
        "Signal that you have completed the task. Provide a structured result object with your output.",
      parameters: {
        type: "object",
        properties: {
          result: {
            type: "object",
            description:
              "Structured output — the final result of this task. Use any JSON structure appropriate for the task (e.g. { \"message\": \"Created 3 entities\" } for simple outcomes, or domain-specific objects for structured pipelines).",
          },
        },
        required: ["result"],
      },
    },
  },
];

export class LlmClient {
  private client: OpenAI;
  private model: string;
  private maxTokens: number;

  constructor(config: LlmConfig) {
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
      maxRetries: 3,
    });
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 4096;
  }

  async chat(
    messages: ChatCompletionMessageParam[],
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    return this.client.chat.completions.create({
      model: this.model,
      messages,
      tools: AGENT_TOOLS,
      tool_choice: "auto",
      max_tokens: this.maxTokens,
    });
  }
}
