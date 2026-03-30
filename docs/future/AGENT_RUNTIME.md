# Agent Runtime Environment (Future Enhancement)

A sandboxed runtime that lets actors spawn, schedule, and manage AI agents on the same machine as their Arke network. Each agent gets its own isolated environment with the Arke CLI, a shell, and access to an LLM provider (BYOK).

## Motivation

The Arke platform is deployable by anyone as a single Docker container. The agent runtime extends this so that a self-hosted network can also run AI agents — no external services, no separate infrastructure. Agents are first-class actors on the network, constrained by the same access control model (classification levels, ACL grants) as human users. If you want more agents, deploy on a bigger machine.

## Core concepts

**Agent = Actor + Sandbox + LLM**

- **Actor**: An `actors` row with `kind = 'agent'` and `owner_id` pointing to the user who spawned it. The agent inherits permissions at or below its creator's clearance level.
- **Sandbox**: An isolated Linux environment (filesystem, process space, network) where the agent executes. It cannot access the host server, other agents' workspaces, or the network's source code.
- **LLM**: A BYOK (bring your own key) connection to any LLM provider. The agent's owner provides the API key, model, and provider config.

**What an agent gets:**

- A persistent workspace directory
- The Arke CLI, pre-configured with the agent's own API key
- A system prompt / personality defining its role and behavior
- A shell where it can run commands, install packages (npm, pip), and execute code
- Network access restricted to the Arke API and the configured LLM endpoint
- Optional: a cron schedule ("run 3x/day") or on-demand invocation

## Sandboxing approach: bubblewrap (bwrap)

This is what Claude Code uses for shell sandboxing. Anthropic open-sourced their implementation as `@anthropic-ai/sandbox-runtime` (Apache 2.0).

**Why bwrap over Docker/gVisor/microVMs:**

| Concern | bwrap | Docker | gVisor | Firecracker |
|---|---|---|---|---|
| Memory overhead per agent | ~0 (kernel structs) | ~25 MB + 150 MB daemon | ~50-100 MB | ~5 MB + KVM required |
| Startup time | ~8 ms | 300-500 ms | 200+ ms | 125 ms |
| Daemon required | No | Yes (dockerd) | No | No |
| Isolation level | Linux namespaces | Linux namespaces | Userspace kernel | Hardware VM |
| Self-hostable on any Linux | Yes | Yes | Yes | Needs KVM / bare metal |

The threat model is accidental damage prevention (agent rm -rf's something, consumes all memory, tries to modify the API server), not hostile multi-tenant isolation. Namespace-level isolation is sufficient. The machine operator deployed the entire stack — there are no untrusted tenants.

**What bwrap provides per sandbox:**

- **PID namespace**: agent can't see host processes or other agents
- **Mount namespace**: agent sees only its workspace + read-only system binaries. No access to server source code, database files, or other agents' directories.
- **cgroups**: memory, CPU, and PID limits prevent runaway agents from starving the database or API server
- **seccomp-bpf**: blocks dangerous syscalls (mount, ptrace, reboot, etc.)
- **Network proxy**: `@anthropic-ai/sandbox-runtime` removes the network namespace entirely inside the sandbox and routes traffic through a proxy that enforces domain allowlists (only the Arke API and the agent's LLM endpoint)

**Resource profile per agent:**

A minimal agent (Node.js process calling an LLM API) uses ~30-50 MB of RAM. Most of the time it's idle, waiting on API responses. On an 8 GB machine running Postgres + the API server, you could comfortably run 10-20 concurrent agents. Agents that are scheduled (not always-on) can share resources by only running during their cron windows.

## Architecture

```
Arke Network (single machine, single Docker container)
+-- Postgres
+-- Arke API (Hono)
+-- Agent Runtime Service
    +-- Agent Manager (lifecycle: create, start, stop, destroy)
    +-- Scheduler (cron-based invocation via BullMQ + Redis)
    +-- Per-agent bwrap sandboxes
        +-- /workspace (persistent bind mount)
        +-- Arke CLI (configured with agent's API key)
        +-- Agent loop: call LLM -> execute tool calls -> return results
        +-- Network proxy (allowlist: Arke API + LLM endpoint)
```

**The agent loop** is straightforward: call the LLM with the agent's system prompt + conversation history + available tools, execute any tool calls in the sandbox, feed results back, repeat until done. No heavyweight framework needed — this is the same pattern as Claude Code.

## LLM interface: OpenAI-compatible format (BYOK)

Agents are model-agnostic. The operator or agent creator provides three fields:

```
base_url:  https://api.groq.com/openai/v1
api_key:   gsk_...
model:     llama-3.1-70b-versatile
```

The OpenAI chat completions API (`/v1/chat/completions`) is the de facto standard. Nearly every provider supports it natively: OpenAI, Groq, Together, Fireworks, DeepSeek, Mistral, Cerebras, SambaNova, and aggregators like OpenRouter (which also bridges Anthropic and Google). Local inference servers (Ollama, LM Studio, vLLM) expose the same format at `localhost`.

**Implementation**: use the `openai` npm package with a swapped `baseURL`. No multi-provider SDK needed.

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: agent.llm.base_url,
  apiKey: decrypt(agent.llm.encrypted_key),
});

const response = await client.chat.completions.create({
  model: agent.llm.model,
  messages,
  tools,
});
```

Tool use follows the OpenAI tools format (`tools` array + `tool_choice: "auto"`). This is well-supported across all major providers. Stick to `tool_choice: "auto"` for maximum compatibility — `"required"` and forced-tool modes have spotty support outside OpenAI.

## API key storage

AES-256-GCM encryption with a server-side `ENCRYPTION_KEY` environment variable. This is the industry standard for self-hosted software (n8n, Retool, Supabase Vault all use this pattern).

- Auto-generate `ENCRYPTION_KEY` on first run if not provided (32 random bytes, hex-encoded)
- Store encrypted keys in the database (never plaintext)
- Never log or return decrypted keys in API responses
- Show a hint for identification: `...abc1`
- If `ENCRYPTION_KEY` is lost, stored keys become unrecoverable (document this clearly)

The key lives in the same `.env` as `DATABASE_URL`. The operator controls the machine — there's no deeper secret to hide it behind.

## Schema additions

The `actors` table already supports `kind = 'agent'` and `owner_id`. The `properties` JSONB column stores agent-specific config:

```jsonc
{
  "name": "research-assistant",
  "system_prompt": "You are a research assistant on the Arke network...",
  "llm": {
    "base_url": "https://api.groq.com/openai/v1",
    "model": "llama-3.1-70b-versatile",
    "encrypted_key": "aes-256-gcm:iv:tag:ciphertext",
    "key_hint": "...abc1"
  },
  "schedule": "0 */8 * * *",    // cron expression: every 8 hours
  "resource_limits": {
    "memory_mb": 256,
    "cpu_fraction": 0.25,
    "max_pids": 128
  }
}
```

## Implementation order

### Step 1: Runtime package (`packages/runtime`)

Build the standalone runtime first — the sandbox, agent loop, and LLM integration — as its own package in the monorepo. This can be developed and tested independently before any API changes. The runtime package handles:

- Spawning bwrap sandboxes with the right mount/network/cgroup config
- The agent loop: LLM call → tool execution → feed results back → repeat
- OpenAI-compatible LLM client (base_url + api_key + model)
- Tool definitions (shell, file read/write)
- Log capture from agent sessions
- Resource limit enforcement

Test it standalone: create a sandbox, give it a prompt, watch it execute. No API integration needed yet.

### Step 2: API integration

Once the runtime works, wire it into the API with new routes and schema changes. The existing `kind = 'agent'` actor type is reused — agents with runtime config are distinguished by having `properties.llm` set.

**New migration** (`packages/schema/016-agent-permissions.sql`):

```sql
CREATE TABLE agent_permissions (
  agent_id     TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  grantee_type TEXT NOT NULL,
  grantee_id   TEXT NOT NULL,
  role         TEXT NOT NULL,                              -- 'admin' | 'operator'
  granted_by   TEXT NOT NULL REFERENCES actors(id),
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, grantee_type, grantee_id),
  CONSTRAINT valid_ap_grantee_type CHECK (grantee_type IN ('actor', 'group')),
  CONSTRAINT valid_agent_perm_role CHECK (role IN ('admin', 'operator'))
);
```

**New routes** (`packages/api/src/routes/agents.ts`):

| Route | Permission | Description |
|-------|-----------|-------------|
| `POST /agents` | authenticated | Create agent with runtime config |
| `GET /agents` | authenticated | List agents caller owns or has access to |
| `GET /agents/:id` | operator+ | Get agent details (LLM key never exposed) |
| `PUT /agents/:id` | admin+ | Update config (prompt, LLM, schedule) |
| `DELETE /agents/:id` | owner/sysadmin | Deactivate agent |
| `POST /agents/:id/invoke` | operator+ | Send prompt, run in sandbox |
| `GET /agents/:id/invocations` | operator+ | Invocation history |
| `POST /agents/:id/permissions` | admin+ | Grant role |
| `DELETE /agents/:id/permissions/:granteeId` | admin+ | Revoke role |
| `GET /agents/:id/permissions` | operator+ | List permissions |

**Encryption utility** (`packages/api/src/lib/crypto.ts`): AES-256-GCM for BYOK LLM API keys, using `ENCRYPTION_KEY` env var.

## Permission model

### Agent clearance ceiling

An agent's permissions are bounded by its creator's permissions:

- `max_read_level` <= creator's `max_read_level`
- `max_write_level` <= creator's `max_write_level`
- `can_publish_public` only if creator has it
- `is_admin` = false (agents cannot be system admins)

The creator can further restrict the agent via ACL grants on specific entities and spaces, just like granting permissions to any other actor.

### Agent invocation permissions

New `agent_permissions` table (same pattern as `entity_permissions` / `space_permissions`):

| Role | Can invoke | Can view config | Can update config | Can manage perms | Can delete |
|------|-----------|-----------------|-------------------|-----------------|------------|
| **operator** | yes | yes (no key) | no | no | no |
| **admin** | yes | yes (no key) | yes | yes | no |
| **owner** (implicit) | yes | yes (no key) | yes | yes | yes |

The LLM API key belongs to the agent, not the invoker. Anyone with `operator` permission can trigger the agent using its configured key. The key is never exposed in API responses — only a hint (`...abc1`). System admins bypass all checks.

## Scheduling

BullMQ (Redis-backed, MIT licensed) handles cron-based scheduling. Each agent with a `schedule` property gets a repeatable BullMQ job. The job triggers the agent's sandbox, runs the agent loop, and records the result. Redis is lightweight (~10 MB baseline) and already a common companion to Node.js services.

For the MVP, scheduling is simple: cron expression + max concurrent runs + timeout. Temporal.io is available as an upgrade path if durable long-running workflows become necessary.

## Tools: shell-first, not pre-built

The agent's tool surface is deliberately minimal — the same approach as Claude Code:

1. **Shell**: execute any command in the sandbox
2. **File read/write**: operate on workspace files
3. **Arke CLI**: pre-installed, pre-configured with the agent's API key

That's it. There is no pre-built PDF parser tool, no web search tool, no code runner tool. If an agent needs to parse a PDF, it writes a Python script. If it needs OCR, it `apt-get install`s Tesseract. If it needs to call a web API, it uses `curl`. The LLM figures out how to accomplish the task using the shell.

This is far more generalizable than trying to anticipate every tool an agent might need. The sandbox gives the agent a real Linux environment — anything you can do in a terminal, the agent can do. The Arke CLI gives it network access. The rest is emergent.

The base sandbox image ships with common utilities pre-installed (Node.js, Python, curl, git, jq) to avoid repeated installs. Agents can install additional packages in their persistent workspace as needed.

## Arke SDK (pre-installed)

Lightweight Python and TypeScript wrappers for programmatic API access — pre-installed in every sandbox so agents don't write auth boilerplate. See [SDK doc](./SDK.md) for full details.

```python
import arke_sdk as arke
entities = arke.get("/entities", params={"limit": 10})
```

The agent's system prompt references all three access methods:

```
Network access is pre-configured:

  CLI:        arke entities list
  Python:     import arke_sdk as arke; arke.get("/entities")
  TypeScript: import * as arke from 'arke-sdk'; await arke.get('/entities')

Env vars $ARKE_API_URL and $ARKE_API_KEY are set.
For API docs: arke help   OR   curl $ARKE_API_URL/llms.txt
```

## Open questions

- **Agent-to-agent communication**: can an agent invoke another agent? Probably yes, via the same `/agents/:id/invoke` route, subject to permissions.
- **Ollama / local models**: if the operator runs Ollama on the same machine, agents could use local models with zero API cost. The sandbox network proxy would need to allowlist localhost:11434.
- **Persistent processes vs on-demand**: some agents may need to stay running (e.g., listening for events). The MVP is on-demand/cron, but a "daemon mode" is a natural extension.
- **Log retention and storage**: how long to keep agent execution logs, and where to store them (database, filesystem, or object storage).
