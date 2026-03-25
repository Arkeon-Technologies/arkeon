# Open Issues

All previous numbered issues (1–21) are resolved. See git history for the old
tracking history.

## Current GitHub Issue

- [#11: Operational hardening for Cloudflare Worker API](https://github.com/Arke-Institute/arke-api/issues/11)

### Summary

The API is functionally in good shape, but production hardening is still
incomplete. The main remaining work is observability, CI, and deploy
verification.

### Why

Current gaps:

- limited structured request/error logging
- no formal CI for `typecheck` and end-to-end coverage
- no automated post-deploy smoke verification
- transient auth transport failures under burst load have been observed, but
  not fully diagnosed with production logs

### Scope

#### 1. Structured logging

- add request-level logs with request ID, method, path, status, and duration
- add structured error logs for uncaught route failures
- include enough metadata to debug auth, content, and Neon failures without
  leaking secrets

#### 2. CI

- run `npm run typecheck`
- run `npm run test:e2e`
- optionally split smoke vs full end-to-end runs if runtime becomes too long

#### 3. Deploy smoke verification

- add a lightweight post-deploy verification step
- confirm health and a few critical read endpoints
- optionally include one authenticated smoke check

#### 4. Auth transport investigation

- use `wrangler tail` or equivalent logs during auth stress runs
- determine whether transient failures are caused by:
  - client/network transport
  - Cloudflare edge disconnects
  - Worker-side route failures
  - upstream Neon behavior

### Acceptance criteria

- request/error logging is present and usable in production
- CI runs typecheck and end-to-end verification automatically
- deploy smoke verification exists and is documented
- auth stress investigation has a written conclusion or a narrower follow-up
