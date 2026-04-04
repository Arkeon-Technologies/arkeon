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

Uses bubblewrap (bwrap) with PID/UTS/IPC namespace isolation, read-only root, writable workspace, and cgroup limits. ~8ms boot overhead. On macOS, falls back to direct execution for development (use Docker for full sandbox fidelity — see below).

## Tools

| Tool | Description |
|------|-------------|
| `shell` | Execute bash commands in the sandbox workspace |
| `read_file` | Read a text file from the workspace |
| `write_file` | Write content to a file (creates directories) |
| `view_image` | View an image file — sent to the model as visual content (multimodal models only) |
| `done` | Signal task completion with structured JSON result |

## Pre-installed Software

See [RUNTIME_ENVIRONMENT.md](./RUNTIME_ENVIRONMENT.md) for the complete list of pre-installed packages, the self-install capability, and Docker vs. local development differences.

## Scheduling

Workers with a `schedule` (cron expression) and `scheduled_prompt` get repeatable BullMQ jobs backed by Redis.

- **Concurrency**: Max 3 concurrent runs; overlapping runs skipped
- **Retry**: 2 attempts with 30s exponential backoff
- **Retention**: Completed jobs kept for 20 runs, failed for 10
- **Graceful fallback**: If `REDIS_URL` is unset, scheduling is disabled but the API runs normally

Docker compose includes Redis under `profiles: ["workers"]`.

## Invocation History

All invocations (HTTP and scheduled) recorded to `worker_invocations` with 30-day retention. Optional full log via `store_log` parameter.

## Permissions

Owner-based with explicit grants. Workers support `operator` and `admin` roles via `worker_permissions` table. System admins bypass.
