# Agent Runtime Environment

A sandboxed runtime that lets actors spawn, schedule, and manage AI workers on the same machine as their Arke network. Each worker gets its own isolated environment with the Arke CLI, a shell, and access to an LLM provider (BYOK).

## Status

**Implemented:**
- `packages/runtime` — standalone sandbox + agent loop + LLM client
- `POST /actors` with `kind=worker` — creates worker with encrypted keys
- `POST /workers/:id/invoke` — invokes worker, returns result
- `GET /workers/:id` — worker config with redacted keys
- `PUT /workers/:id` — update worker config
- AES-256-GCM encryption for BYOK LLM keys and system-managed Arke keys
- Tested end-to-end with Gemini 2.0 Flash

**Not yet implemented:**
- Cron scheduling (BullMQ + Redis)
- Worker permissions table (currently owner-only)
- Invocation history / logs table
- Arke CLI pre-installed in sandbox (currently uses curl + env vars)
- Persistent workspaces (currently ephemeral per invocation)

## Two actor kinds

| Kind | What it is | API key returned? | Invokable? |
|------|-----------|-------------------|------------|
| `agent` | Service account (Claude Code, integrations, colleagues) | Yes (shown once) | No |
| `worker` | Runtime agent on the machine | No (system-managed, encrypted) | Yes, via `/workers/:id/invoke` |

## How workers work

### Creation

`POST /actors` with `kind=worker` plus worker-specific fields:

```json
{
  "kind": "worker",
  "name": "research-assistant",
  "system_prompt": "You are a research assistant on the Arke network...",
  "llm": {
    "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
    "api_key": "AIza...",
    "model": "gemini-2.0-flash"
  }
}
```

The API:
1. Creates an actor with `kind=worker` and `owner_id` set to the caller
2. Generates an Arke API key — hashes it into `api_keys` (normal auth flow)
3. Encrypts the plaintext Arke key with AES-256-GCM → stores in `properties.arke_key_encrypted`
4. Encrypts the LLM API key the same way → stores in `properties.llm.api_key_encrypted`
5. Returns the actor record with **no API key** — both keys are system-managed

### Invocation

`POST /workers/:id/invoke` with `{ "prompt": "..." }`:

1. Verifies caller is the worker's `owner_id` (or sysadmin)
2. Decrypts both keys from properties
3. Creates a temp workspace directory
4. Spawns a sandboxed agent with `ARKE_API_URL` and `ARKE_API_KEY` injected
5. Runs the agent loop (LLM call → tool execution → repeat until done)
6. Returns `{ success, summary, iterations }`
7. Cleans up workspace

### Properties shape (stored in DB)

```json
{
  "name": "research-assistant",
  "system_prompt": "You are a research assistant...",
  "llm": {
    "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
    "model": "gemini-2.0-flash",
    "api_key_encrypted": "base64(iv+ciphertext+tag)",
    "api_key_hint": "AIza...J6pc"
  },
  "arke_key_encrypted": "base64(iv+ciphertext+tag)",
  "arke_key_hint": "ak_d...841c",
  "max_iterations": 50,
  "resource_limits": {
    "memory_mb": 256,
    "cpu_percent": 50,
    "max_pids": 128,
    "timeout_ms": 300000
  }
}
```

## Sandboxing: bubblewrap (bwrap)

What Claude Code uses. Near-zero overhead (~8ms boot, ~0 memory beyond the process). On macOS, falls back to direct execution in the workspace directory for development.

Each sandbox gets:
- PID namespace isolation
- Read-only root filesystem + writable workspace
- cgroup resource limits
- `ARKE_API_URL` and `ARKE_API_KEY` env vars for network access

## LLM interface: OpenAI-compatible (BYOK)

Any provider that supports the OpenAI chat completions format works: OpenAI, Gemini, Groq, Together, Fireworks, DeepSeek, Mistral, Ollama, OpenRouter. Config is just `base_url + api_key + model`.

## Tools: shell-first

Workers get three tools: `shell`, `read_file`, `write_file`, plus a `done` signal. No pre-built tool library — if a worker needs to parse a PDF, it writes a script. If it needs Tesseract, it installs it. The LLM figures out how to accomplish the task.

## Key storage

AES-256-GCM encryption with `ENCRYPTION_KEY` env var (64-char hex = 32 bytes). Two encrypted keys per worker:
- **Arke API key** — system-managed, never shown to anyone
- **LLM provider key** — BYOK, provided at creation, encrypted at rest

Both decrypted only at invocation time, injected into the sandbox, cleaned up after.

## Permissions (MVP)

Owner-only. Only the actor at `owner_id` can invoke, view, or update a worker. System admins bypass all checks.

Future: `worker_permissions` table with operator/admin roles, following the same pattern as `entity_permissions` and `space_permissions`.

## Scheduling (not yet implemented)

Plan: BullMQ (Redis-backed) for cron scheduling. Each worker with a `schedule` property gets a repeatable job. The scheduler decrypts keys and invokes the runtime the same way the API endpoint does.

See the scheduling design section below for details.

## Scheduling design

### How it would work

Workers can optionally have a `schedule` field in their properties — a cron expression like `"0 */8 * * *"` (every 8 hours). A scheduler service (part of the API process or a sidecar) polls for workers with schedules and runs them.

### Components needed

1. **Redis** — BullMQ's backing store. Lightweight (~10 MB baseline).
2. **BullMQ queue** — a `worker-schedules` queue with repeatable jobs
3. **Scheduler sync** — on API startup, scan workers with `schedule` set, create/update BullMQ repeatable jobs
4. **Worker process** — BullMQ worker that processes jobs by calling the same invoke logic as `POST /workers/:id/invoke`

### Schedule management

When a worker is created or updated with a `schedule`:
- Upsert a BullMQ repeatable job keyed by worker ID
- If schedule is removed (set to null), remove the repeatable job

### Scheduled invocation prompt

Scheduled runs need a prompt. Options:
- A `scheduled_prompt` field in worker properties (static prompt for every cron run)
- Default to something like: "You are running on your scheduled interval. Check for new work and process it."

### API additions

```
POST /workers/:id/schedule    — set or update cron schedule
DELETE /workers/:id/schedule  — remove schedule
GET /workers/:id/schedule     — get current schedule + next run time
```

Or simpler: just use `PUT /workers/:id` with `{ "schedule": "0 */8 * * *" }` to set, `{ "schedule": null }` to remove.

### Docker compose changes

Add Redis as an optional service:

```yaml
redis:
  image: redis:7-alpine
  profiles: ["workers"]
  ports: ["6379:6379"]
```

### Open questions

- **Scheduled prompt**: static field vs dynamic (e.g., check inbox for tasks)?
- **Concurrency**: what if a scheduled run is still going when the next one triggers? Skip, queue, or run in parallel?
- **Failure handling**: retry on failure? Max retries? Backoff?
- **Log storage**: where do scheduled run results go? A `worker_invocations` table?

## Open questions

- **Worker-to-worker communication**: can a worker invoke another worker? Probably yes, if the calling worker's actor has the right permissions.
- **Ollama / local models**: workers could use local models at `localhost:11434` with zero API cost.
- **Persistent workspaces**: currently ephemeral per invocation. Could persist for workers that need state across runs.
- **Invocation history**: a `worker_invocations` table to track runs, status, duration, and results.
- **Arke SDK in sandbox**: pre-install `arke-sdk` (Python/TypeScript) for cleaner programmatic access. See [SDK doc](./SDK.md).
