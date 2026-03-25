# API Backlog

Current status:
- Cloudflare Worker is deployed and live
- Neon and R2 are wired up
- direct and presigned content flows are implemented
- the split `vitest` e2e suite passes
- stress/load scripts exist under `test/stress/`

This file now tracks the real remaining backlog, not the earlier
pre-implementation checklist.

## Remaining Work

### 1. Spec / Docs Sync

The main implementation is ahead of the planning docs.

- continue updating `routes/` planning files to match current Worker behavior
- keep docs aligned with the in-progress `/help` / OpenAPI route-help refactor
- keep error-contract and worker-stack docs aligned with the implemented routes

### 2. Auth Client Robustness

Server-side auth is functioning, but bursty registration can hit transient
transport failures. The client should adopt the documented retry policy.

- implement challenge/register retry + backoff in the CLI/client
- restart from a fresh challenge after any network or `5xx` failure
- do not retry terminal `4xx` auth errors

Reference:
- `docs/AUTH_CLIENT_ROBUSTNESS.md`

### 3. Operational Hardening

This is the main remaining engineering issue.

- request logging and structured diagnostics
- better production observability around route failures and auth bursts
- CI for `typecheck` and e2e
- optional automated smoke deploy verification
- optional deeper auth transport investigation with `wrangler tail`

This is a good GitHub issue candidate.

## Not Immediate Priorities

These exist and are good enough for now:
- functional e2e coverage
- presigned upload flow
- concurrency tests
- pagination tests
- stress/load scripts

## Suggested Issue Candidates

### Issue 1: Operational Hardening

Scope:
- structured request/error logging
- CI for `typecheck` and e2e
- deploy smoke verification
- tail/log investigation for transient auth transport failures

### Issue 2: Spec / Docs Reconciliation

Scope:
- update `routes/` planning files
- update filtering docs
- make repo docs reflect current Worker/test architecture

### Issue 3: CLI Auth Retry Adoption

Scope:
- implement `challenge` / `register` retry policy in the CLI
- exponential backoff with jitter
- fresh challenge on retry after transport failure
