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

## Schema additions

The `actors` table already supports `kind = 'agent'` and `owner_id`. The `properties` JSONB column stores agent-specific config:

```jsonc
{
  "name": "research-assistant",
  "system_prompt": "You are a research assistant on the Arke network...",
  "llm": {
    "provider": "anthropic",     // or "openai", "ollama", etc.
    "model": "claude-sonnet-4-6",
    "api_key_ref": "encrypted-ref" // never stored in plaintext
  },
  "schedule": "0 */8 * * *",    // cron expression: every 8 hours
  "resource_limits": {
    "memory_mb": 256,
    "cpu_fraction": 0.25,
    "max_pids": 128
  },
  "tools": ["shell", "arke-cli", "web-search"] // pre-built tool modules
}
```

## API routes

```
POST   /agents              -- spawn a new agent (creates actor + sandbox)
GET    /agents              -- list agents owned by the caller
GET    /agents/:id          -- get agent status and config
PUT    /agents/:id          -- update config (prompt, schedule, LLM, etc.)
DELETE /agents/:id          -- destroy agent (tears down sandbox)
POST   /agents/:id/invoke   -- send a message / task to the agent
GET    /agents/:id/logs     -- stream or retrieve agent execution logs
POST   /agents/:id/start    -- start a stopped agent
POST   /agents/:id/stop     -- stop a running agent
```

## Permission model

An agent's permissions are bounded by its creator's permissions:

- `max_read_level` <= creator's `max_read_level`
- `max_write_level` <= creator's `max_write_level`
- `can_publish_public` only if creator has it
- `is_admin` = false (agents cannot be system admins)

The creator can further restrict the agent via ACL grants on specific entities and spaces, just like granting permissions to any other actor.

## Scheduling

BullMQ (Redis-backed, MIT licensed) handles cron-based scheduling. Each agent with a `schedule` property gets a repeatable BullMQ job. The job triggers the agent's sandbox, runs the agent loop, and records the result. Redis is lightweight (~10 MB baseline) and already a common companion to Node.js services.

For the MVP, scheduling is simple: cron expression + max concurrent runs + timeout. Temporal.io is available as an upgrade path if durable long-running workflows become necessary.

## Pre-built tools

Agents get a base set of tools, extensible over time:

- **shell**: execute commands in the sandbox
- **arke-cli**: interact with the network (create entities, query, manage relationships)
- **file-read / file-write**: operate on workspace files

Future additions:

- **web-search**: search the web via a provider API
- **web-fetch**: retrieve and parse web pages
- **pdf-parse**: extract text from PDFs
- **code-run**: execute Python/JS snippets with output capture

Tools are defined as modules that the agent loop can call. Adding a new tool means writing a function that executes in the sandbox and returns structured output.

## Open questions

- **API key storage**: encrypted in the database? Vault? Environment variable injected at sandbox creation? Needs a decision before implementation.
- **Agent-to-agent communication**: can an agent invoke another agent? Probably yes, via the same `/agents/:id/invoke` route, subject to permissions.
- **Ollama / local models**: if the operator runs Ollama on the same machine, agents could use local models with zero API cost. The sandbox network proxy would need to allowlist localhost:11434.
- **Persistent processes vs on-demand**: some agents may need to stay running (e.g., listening for events). The MVP is on-demand/cron, but a "daemon mode" is a natural extension.
- **Log retention and storage**: how long to keep agent execution logs, and where to store them (database, filesystem, or object storage).
