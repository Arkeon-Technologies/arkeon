# API Implementation TODO

Current status: Worker scaffold is deployed, Neon is connected, and the initial read baseline is live. This document tracks the remaining implementation work in priority order.

## In Progress

- Expand shared SQL helpers for filtering, sorting, pagination, and CAS mutations
- Complete entity and commons CRUD
- Complete access management endpoints

## Core API

- `POST /entities`
- `PUT /entities/:id`
- `POST /commons`
- `PUT /commons/:id`
- `DELETE /commons/:id`
- `GET /commons/:id/entities`
- `GET /commons/:id/commons`
- `GET /commons/:id/feed`
- `GET /entities/:id/versions/:ver`

## Access

- `PUT /entities/:id/access`
- `PUT /entities/:id/access/owner`
- `POST /entities/:id/access/grants`
- `DELETE /entities/:id/access/grants/:actor_id`
- `DELETE /entities/:id/access/grants/:actor_id/:type`
- Enforce the app-level rule that admins cannot revoke other admins

## Relationships

- `GET /entities/:id/relationships`
- `POST /entities/:id/relationships`
- `GET /relationships/:rel_id`
- `PUT /relationships/:rel_id`
- `DELETE /relationships/:rel_id`

## Auth

- `POST /auth/challenge`
- `POST /auth/register`
- `POST /auth/recover`
- `POST /auth/keys`
- `DELETE /auth/keys/:id`

## Comments

- `POST /entities/:id/comments`
- `GET /entities/:id/comments`
- `DELETE /entities/:id/comments/:comment_id`

## Content / Files

- `POST /entities/:id/content/upload-url`
- `POST /entities/:id/content/complete`
- `GET /entities/:id/content`
- `DELETE /entities/:id/content`
- `PATCH /entities/:id/content`
- Return `501 not_implemented` for direct `POST /entities/:id/content`

## Search / Activity / Inbox

- `GET /search`
- `GET /actors/:actor_id/activity`
- `GET /auth/me/inbox`
- `GET /auth/me/inbox/count`
- `fanOutNotifications()` via `waitUntil`

## Hardening

- Uniform sort and filter validation across all listing endpoints
- Better SQL helpers for permission-aware inserts and updates
- More complete 403 vs 404 vs 409 handling
- Request logging and structured internal diagnostics
- Expanded e2e coverage for auth, mutations, CAS conflicts, and permissions
