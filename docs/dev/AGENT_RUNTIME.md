# Agent Runtime

Sandboxed runtime for AI workers. Each worker gets an isolated Linux environment with pre-installed tools, SDKs, and access to an LLM provider (BYOK).

## Design Philosophy

**Shell-first tools**: Workers get `shell`, `read_file`, `write_file`, `view_image`, and a `done` signal. No pre-built tool library — if a worker needs to parse a PDF, it writes a script. The LLM figures out how. Common packages are pre-installed so it doesn't need to figure out how to install them.

**Self-sufficient agents**: Workers receive a comprehensive system prompt with the full CLI reference, SDK cheat sheets, API response patterns, and filter syntax — everything needed to use the platform correctly without discovery calls. The prompt is generated from the OpenAPI spec at startup so it's always current.

**Two actor kinds**: Agents are service accounts (get API key, not invokable). Workers are runtime agents (system-managed encrypted keys, invokable via `/workers/:id/invoke`).

**BYOK LLM**: Any OpenAI-compatible provider works (OpenAI, Gemini, Groq, Together, DeepSeek, Mistral, Ollama, OpenRouter). Config is `base_url + api_key + model`. Multimodal models can use `view_image` to see images.

## Key Storage

AES-256-GCM with `ENCRYPTION_KEY` env var (generate: `openssl rand -hex 32`). Two encrypted keys per worker:
- **Arke API key** — system-managed, never shown to anyone
- **LLM provider key** — BYOK, provided at creation, encrypted at rest

Both decrypted only at invocation time, injected into sandbox, cleaned up after.

## Sandboxing

On Linux, uses bubblewrap (bwrap) with PID/UTS/IPC namespace isolation, read-only root, writable workspace, and cgroup limits. ~8ms boot overhead. On macOS, falls back to direct execution in the workspace dir — less isolated, but enough for development.

Install the worker toolchain before creating workers:
- **Linux**: `sudo apt-get install bubblewrap curl jq python3`
- **macOS**: `brew install curl jq python3`

`arkeon start` warns at boot if these are missing but does not refuse to run.

## Tools

| Tool | Description |
|------|-------------|
| `shell` | Execute bash commands in the sandbox workspace |
| `read_file` | Read a text file from the workspace |
| `write_file` | Write content to a file (creates directories) |
| `view_image` | View an image file — sent to the model as visual content (multimodal models only) |
| `done` | Signal task completion with structured JSON result |

## Pre-installed Software

See [RUNTIME_ENVIRONMENT.md](./RUNTIME_ENVIRONMENT.md) for the complete list of packages workers expect to find at system paths.

## Scheduling

Workers with a `schedule` (cron expression) and `scheduled_prompt` get recurring in-process tasks via `node-cron`. Everything runs inside the API process — no external broker.

- **Concurrency**: Overlapping runs are skipped (the prior invocation must finish first)
- **Persistence**: Schedules live in `actors.properties` and are re-synced at API startup
- **Graceful shutdown**: Tasks are stopped cleanly on SIGTERM/SIGINT as part of the API drain

## Invocation History

All invocations (HTTP and scheduled) recorded to `worker_invocations` with 30-day retention. Optional full log via `store_log` parameter.

## Permissions

Owner-based with explicit grants. Workers support `operator` and `admin` roles via `worker_permissions` table. System admins bypass.
