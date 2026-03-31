# Agent Runtime

Sandboxed runtime for AI workers. Each worker gets an isolated environment with the Arke CLI, a shell, and access to an LLM provider (BYOK).

## Design Philosophy

**Shell-first tools**: Workers get `shell`, `read_file`, `write_file`, and a `done` signal. No pre-built tool library — if a worker needs to parse a PDF, it writes a script. The LLM figures out how.

**Two actor kinds**: Agents are service accounts (get API key, not invokable). Workers are runtime agents (system-managed encrypted keys, invokable via `/workers/:id/invoke`).

**BYOK LLM**: Any OpenAI-compatible provider works (OpenAI, Gemini, Groq, Together, DeepSeek, Mistral, Ollama, OpenRouter). Config is `base_url + api_key + model`.

## Key Storage

AES-256-GCM with `ENCRYPTION_KEY` env var (generate: `openssl rand -hex 32`). Two encrypted keys per worker:
- **Arke API key** — system-managed, never shown to anyone
- **LLM provider key** — BYOK, provided at creation, encrypted at rest

Both decrypted only at invocation time, injected into sandbox, cleaned up after.

## Sandboxing

Uses bubblewrap (bwrap) with PID/UTS/IPC namespace isolation, read-only root, writable workspace, and cgroup limits. ~8ms boot overhead. On macOS, falls back to direct execution for development.

Pre-installed in sandbox: curl, jq, python3, arkeon (Arkeon CLI at `/usr/local/bin/arkeon`).

## Scheduling

Workers with a `schedule` (cron expression) and `scheduled_prompt` get repeatable BullMQ jobs backed by Redis.

- **Concurrency**: Max 3 concurrent runs; overlapping runs skipped
- **Retry**: 2 attempts with 30s exponential backoff
- **Retention**: Completed jobs kept for 20 runs, failed for 10
- **Graceful fallback**: If `REDIS_URL` is unset, scheduling is disabled but the API runs normally

Docker compose includes Redis under `profiles: ["workers"]`.

## Invocation History

All invocations (HTTP and scheduled) recorded to `worker_invocations` with 30-day retention. Optional full log via `store_log` parameter.

## Permissions (MVP)

Owner-only. Only `owner_id` can invoke, view, or update. System admins bypass. Future: `worker_permissions` table with operator/admin roles.

## Open Questions

- **Worker-to-worker communication**: can a worker invoke another worker?
- **Ollama / local models**: zero-cost local inference at `localhost:11434`
- **Persistent workspaces**: currently ephemeral per invocation
- **Arke SDK**: pre-install Python/TypeScript SDK for cleaner programmatic access (see [SDK doc](./future/SDK.md))
