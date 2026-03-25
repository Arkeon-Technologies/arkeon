# Auth Client Robustness

The auth flow is correct under concurrent use, but bursty registration can hit
transient transport failures between the client and the Cloudflare edge.

Observed behavior during stress testing:
- failures were network/transport errors, not stable API contract failures
- retry with backoff was enough to recover
- forcing `Connection: close` did not eliminate the issue

## Recommendation

Clients should treat auth registration as a retryable workflow.

Flow:
1. `POST /auth/challenge`
2. solve PoW locally
3. sign the nonce
4. `POST /auth/register`

If any network error or `5xx` happens at any point after step 1:
- discard the current challenge
- wait with exponential backoff plus jitter
- restart from `POST /auth/challenge`

Do not retry these `4xx` responses:
- `pow_invalid`
- `signature_invalid`
- `already_exists`
- `pow_expired`
- other request-shape validation errors

## Suggested Policy

- max attempts: `3-5`
- base backoff: `250-500 ms`
- multiplier: `2x`
- jitter: `0-250 ms`

Example:
- attempt 1: immediate
- attempt 2: `~500 ms`
- attempt 3: `~1 s`
- attempt 4: `~2 s`

## Why Restart From Challenge

Challenges are single-use and time-bound. Restarting from a fresh challenge is
the safest client rule because it avoids ambiguity around whether a previous
register request partially succeeded or whether the nonce was already consumed.

## Scope

This recommendation is mainly for:
- CLI registration
- automated agents provisioning keys
- batch onboarding tools

Normal authenticated API usage should still retry ordinary transient network
errors, but the challenge/register pair needs special handling because it is a
multi-step auth handshake.
