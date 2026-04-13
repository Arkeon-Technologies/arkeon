# Advanced and in-development features

Features that are functional but under active development. They may
change significantly between releases. If you're evaluating Arkeon,
start with the [quickstart](user/QUICKSTART.md) — everything below is
opt-in and not required for core usage.

---

## Knowledge extraction pipeline (in development)

A background service that watches for new content uploads and
automatically extracts structured knowledge — text chunks, PDF/PPTX/DOCX
pages, visual descriptions, entity relationships — using an LLM.

**Status:** Functional but evolving. The extraction quality, job
management, and configuration surface are all under active iteration.

It is **off by default** because it:

- makes continuous outbound LLM calls (cost scales with content volume),
- requires an LLM provider to be configured at runtime,
- runs a poller that wakes every 10 seconds even when idle,
- writes new entities and relationships back into the graph.

### Enabling it

Two steps, both required.

**1. Enable the pipeline.** Set in `.env`:

```bash
ENABLE_KNOWLEDGE_PIPELINE=true
```

Restart the API. You should see:

```
[knowledge] pipeline enabled
```

**2. Configure an LLM provider.** There is no env-var fallback and no
provider-specific default. Every field — `provider` label, `base_url`,
`api_key`, `model` — must be supplied explicitly. Any OpenAI-compatible
endpoint works (OpenAI, Anthropic via their compat shim, OpenRouter,
local llama.cpp, vLLM, etc.).

The easy path is `arkeon init`, which prompts for these values and pushes
them on `arkeon up`. The direct path is `PUT /knowledge/config`:

```bash
curl -X PUT "$ARKE_API/knowledge/config" \
  -H "X-API-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "llm": {
      "default": {
        "provider": "openai",
        "base_url": "https://api.openai.com/v1",
        "api_key": "sk-...",
        "model": "gpt-4.1-nano"
      }
    }
  }'
```

The `provider` field is a free-form label — it has no behavioral meaning
and is shown in `GET /knowledge/config` to help you remember what's
plumbed in. Until a config is stored, extraction jobs throw
`No LLM provider configured...`.

### How it works

1. **Poller** — reads `entity_activity` from a monotonic `BIGSERIAL` cursor
   (`knowledge_poller_state.last_activity_id`). Batches 50 new events per
   tick, skipping events authored by the knowledge-service actor itself so
   it doesn't ingest its own writes.

2. **Queue** — Postgres-backed job table. Default concurrency is 10 and can
   be tuned via `MAX_KNOWLEDGE_CONCURRENCY`. Jobs are typed: `ingest`
   routes to a content-type-specific handler (`pdf.extract`,
   `pptx.extract`, `docx.extract`, `text.extract`, etc.), which may fan
   out to child jobs (`pdf.page_group`, `text.chunk_extract`, ...).

3. **Handlers** — live in `packages/arkeon/src/server/knowledge/pipeline/`. Each one
   takes a job record and the associated entity, produces new entities and
   relationships, and records token usage on the job.

### Tuning knobs

| Variable | Default | Meaning |
|---|---|---|
| `ENABLE_KNOWLEDGE_PIPELINE` | `false` | Master switch |
| `KNOWLEDGE_POLLER_INTERVAL_MS` | `10000` | Poller tick interval |
| `MAX_KNOWLEDGE_CONCURRENCY` | `10` | Parallel jobs |
| `CHUNK_EXTRACT_CONCURRENCY` | `4` | Parallel LLM calls inside a single text chunking job |

LLM provider settings (`provider`, `base_url`, `api_key`, `model`,
`max_tokens`) live in the `knowledge_config` table, not in env vars.
Manage them via `PUT /knowledge/config`.

### Disabling it

Unset the flag (or set it to anything other than `true`) and restart. The
poller and queue will not boot; existing job rows remain in the database
but won't be processed until re-enabled.

HTTP routes under `/knowledge/*` remain mounted even when disabled — list
endpoints will return empty, and `POST /knowledge/ingest` will enqueue
jobs that sit unprocessed.

### Cost warning

The pipeline was originally tuned against vision-capable mid-tier models
in the `gpt-4o` / `gpt-4o-mini` class. A single PDF page with vision can
run roughly $0.001–$0.01 depending on image size and prompt length.
Whatever provider you point at, set a reasonable spend cap on the
provider account before enabling the pipeline at scale.

---

## Worker runtime (in development)

Sandboxed AI agents that can read and write the knowledge graph
autonomously. Workers execute shell commands in an isolated environment
with access to the Arkeon API.

**Status:** Functional but the scheduling, invocation management, and
developer experience are under active iteration. The sandbox provides
real isolation on Linux (via bubblewrap); macOS uses a direct-execution
fallback without isolation boundaries.

### What workers are

A worker is an actor (kind = `worker`) with:
- A system prompt defining its behavior
- Access to shell tools (`bash`, `curl`, `jq`, `python3`)
- An API key scoped to its permissions
- An optional cron schedule for recurring execution

Workers are BYOK (bring your own key) — each worker invocation calls
an LLM provider you configure. The worker itself does not ship with or
require any specific LLM.

### Prerequisites

- **Linux**: `sudo apt-get install bubblewrap curl jq python3`
- **macOS**: `brew install curl jq python3` (no bubblewrap — unsandboxed fallback)

`arkeon start` / `up` warns at boot if these are missing but won't
refuse to start. Workers that shell out will fail at runtime if the
tools aren't installed.

### How invocations work

Workers are invoked via `POST /workers/:id/invoke`. Each invocation:
1. Creates a sandboxed environment with the worker's tools and API key
2. Sends the system prompt + invocation prompt to the configured LLM
3. The LLM can call tools (shell commands, API requests) in a loop
4. Results, token usage, and duration are recorded

Invocations have retry logic with backoff. History is retained for 30
days by default.

### Scheduling

Workers can be scheduled via `node-cron` expressions. The scheduler
runs in-process — no external cron daemon needed. Scheduled workers
execute automatically at their configured interval.

For full details on the sandbox environment, pre-installed packages,
and environment variables available to workers, see
[dev/RUNTIME_ENVIRONMENT.md](dev/RUNTIME_ENVIRONMENT.md) and
[dev/AGENT_RUNTIME.md](dev/AGENT_RUNTIME.md).

---

## Cron runtime (planned — v1.1)

A more robust scheduling system for worker execution, replacing the
current in-process `node-cron` approach. Design is not finalized.

---

## Rate limiting (not implemented)

Arkeon currently ships **without any in-process rate limiting**. This is
deliberate for the current phase — the product target is a local-first
tool that users run on their own machine via `arkeon up`, and a local
limiter mostly just gets in the way of legitimate browser traffic and
scripts.

For public or multi-tenant deployments this will need to be revisited.
When we do, the design notes below capture the decisions we already
wrestled with so we don't re-litigate them.

### Why "just add a token bucket" is not the answer

An earlier iteration of this repo shipped an in-process per-IP token
bucket keyed on the remote address. It had three problems that together
argued for ripping it out and doing this properly later:

1. **Path exemption was a bypass vector.** A single explorer SPA load
   fetches 20–40 static assets in parallel, easily exceeding any
   reasonable burst cap. We worked around that by exempting `/explore/*`
   and `/help/*` by path — at which point an attacker could just hit
   those paths in a loop to drain CPU and the limiter provided no
   protection. Once you start exempting by path you've admitted the
   limiter can't distinguish abuse from legitimate load.

2. **"Has an API key header" is not the same as "is authorized".** The
   first version bypassed any request that *presented* an API key
   header, which meant an attacker could skip the bucket entirely with
   `-H 'x-api-key: anything'` and then brute-force the `api_keys`
   SELECT at full speed. We tried to fix this with a validated-key
   cache (see the commit history for `valid-keys-cache.ts`) but the
   cache introduces its own eviction, cold-start, and multi-replica
   concerns, and it still leaves the SELECT reachable for the first
   N requests per IP before throttling kicks in.

3. **Wrong layer.** In-process rate limiting in a Node server behind a
   load balancer is strictly worse than edge rate limiting at the LB
   itself. Cloudflare, AWS WAF, nginx `limit_req`, and the control
   plane's Cloudflare Worker can all do this with per-route rules,
   global counters, and proper observability. A home-grown token
   bucket inside the API process ends up duplicating state across
   replicas and is invisible to the ops dashboards.

### What to do instead, when the time comes

- **For the managed SaaS control plane (`arkeon-deploy`)**: apply rate
  limits at the Cloudflare layer in front of `deploy.arkeon.tech`.
  This is the correct spot — it sees every request, has per-tenant
  context from the deployment slug, and costs zero extra infra.

- **For user-owned per-tenant instances behind `{slug}.arkeon.tech`**:
  apply rate limits in the per-instance nginx/Caddy that fronts the
  API container, or enable Cloudflare's HTTP rate-limiting rules for
  the instance's hostname. Configure by plan tier.

- **For the bare API process** (users running `arkeon up` directly):
  no limiter by default. If a user wants one for some reason, the
  right shape is probably per-actor quotas recorded in the database
  (rows in `api_keys` with last-N-minute counters), not per-IP
  buckets. Per-actor is a straightforward migration once we have real
  abuse signal to design against.

### What to bring back if we do this

If we do implement something in-process (e.g. for a proof-of-concept
deployment before Cloudflare is wired up), the thing to reach for is
the **validated-key cache** pattern — not the token bucket itself.
Track which key hashes have already validated against `api_keys` and
skip the SELECT on subsequent requests. That's a win regardless of
whether there's a rate limit on top of it, because it removes load
from the most heavily hit query in the auth path.
