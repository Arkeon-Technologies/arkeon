# CLI Instance Profiles (Future Enhancement)

Today the Arkeon CLI assumes a single ambient instance: there is one
configured `apiUrl`, one stored API key, and one `pendingLlmConfig`
slot. That's correct for the MVP — most users will have one local stack
or one remote deployment they care about — but it falls over the moment
someone wants to run more than one Arkeon instance side by side on the
same machine.

## What "more than one instance" looks like

Concrete cases that already exist or are imminent:

- A user running a local stack against their personal knowledge graph
  AND simultaneously testing a fresh stack against a different Genesis
  seed for a demo.
- A developer with a `cli-quickstart` worktree running on `:8001` and a
  `merge-feature` worktree running on `:8002`, both via `arkeon up`.
- A consultant managing several customers' deployments at
  `acme.arkeon.tech`, `widget.arkeon.tech`, etc., from one CLI install.
- The same developer wanting to point at staging vs production of a
  single deployment without re-typing API keys.

In all of these the CLI today forces the user to manually `arkeon
config set-url` and `arkeon auth set-api-key` every time they switch.
The conf store has one slot, and `arkeon up` clobbers it.

## Proposed shape

Add a "profile" concept to the CLI conf layout. A profile is a named
bundle of:

- `apiUrl` (the existing config store value)
- `apiKey` + `keyPrefix` + optional identity keypair (the existing
  credentials store value)
- `spaceId` (the existing default space override)
- `pendingLlmConfig` (the brief carrier between `init` and `up`)

The conf stores stay the same on disk but become keyed by profile name:

```jsonc
// ~/Library/Preferences/arkeon-cli/config.json
{
  "activeProfile": "local",
  "profiles": {
    "local":     { "apiUrl": "http://localhost:8000" },
    "staging":   { "apiUrl": "https://staging.arkeon.tech", "spaceId": "01..." },
    "acme-prod": { "apiUrl": "https://acme.arkeon.tech" }
  }
}
```

Credentials work the same way, namespaced by profile.

### CLI surface

```
arkeon profile list                    # show all profiles, marking active
arkeon profile use <name>              # switch active profile
arkeon profile create <name> --url <url>
arkeon profile delete <name>
arkeon profile rename <old> <new>
```

Plus a `--profile <name>` global flag (alongside the existing
`--api-url` / `--space-id` overrides) so single commands can target a
profile without flipping the global active state:

```
arkeon --profile staging entities list
arkeon --profile acme-prod seed --dry-run
```

`arkeon init` would gain `--profile <name>` and create the named
profile (defaulting to a slug derived from cwd, e.g. the directory
name) instead of clobbering the active one. `arkeon up` would write its
results into that profile.

### Migration

The first time the CLI is run after this lands, the existing flat
config layout is migrated into a profile named `default` and that
profile becomes active. No user action required; existing scripts that
call `arkeon config set-url` keep working against the active profile.

## Open questions to settle when this lands

1. **Profile scope of `pendingLlmConfig`.** It's a per-instance carrier,
   so it should live inside each profile. Confirm.
2. **Worktree integration.** Should `arkeon init` in a worktree create
   a profile named after the worktree slug automatically? That would
   plug into the local-dev skill cleanly but introduces magic.
3. **Profile in env var.** `ARKE_PROFILE=staging` as a process-local
   override, mirroring `ARKE_API_URL` / `ARKE_SPACE_ID`. Probably yes.
4. **Profile vs space.** A profile bundles "which instance + which key";
   a space is an in-instance scoping concept. They are orthogonal.
   Document the distinction in `arkeon profile --help` so people don't
   expect spaces to switch when they switch profiles.
5. **Conf store on-disk format.** The existing `Conf` library supports
   dotted-path access, so the migration is mechanical, but we need to
   decide whether `credentials.json` becomes a single keyed map or
   stays flat with the profile name baked into a `credentials.<name>`
   property.
6. **`arkeon up` and shared docker compose project names.** Two profiles
   pointing at two local stacks need two distinct docker compose
   project names so they don't share volumes. The local-dev skill
   already handles this for worktrees via `-p arkeon-<slug>`. The CLI
   should probably do the same automatically when `arkeon up` runs
   inside a non-default profile.

## Why not now

The MVP ships without profiles because:

- One ambient instance is the right default for the "I just installed
  this from npm and want to try the demo" path.
- Adding profiles before there's a second user driving demand for them
  ossifies the design around guesswork.
- The conf-store migration is reversible — flat-to-profiled is a
  one-way function but a small one, and the file format isn't a public
  contract.

When the second concrete need shows up (or when the multi-worktree dev
loop gets painful enough), revisit this doc.
