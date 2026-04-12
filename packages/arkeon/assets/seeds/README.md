# Genesis Seed — The Creation Account

A pre-built `arke.ops/v1` knowledge graph of the seven-day Creation account
(Genesis 1:1 – 2:3), bilingual in Septuagint Greek and King James English. It
exists so a fresh Arkeon deployment can be loaded with a real, recognizable
graph in seconds — no extraction step required.

## What's in the graph

- **76 entities** in total:
  - 1 `book` — Genesis
  - 2 `chapter` entities — Genesis 1, Genesis 2
  - 7 `creation_day` entities — Day 1 through Day 7
  - 34 `verse` entities — every verse from 1:1 through 2:3, each carrying
    both `text_grc` (the Septuagint) and `text_en` (the KJV) inline as
    properties
  - ~30 concept entities — `god`, `light`, `darkness`, `firmament`, `waters`,
    `dry_land`, `seas`, `grass`, `herb`, `fruit_tree`, `greater_light`,
    `lesser_light`, `stars`, `whales`, `fowl`, `cattle`, `creeping_thing`,
    `beast`, `man`, `woman`, `image_of_god`, `sabbath`, `evening`, `morning`,
    and so on
- **~220 relationships** spanning these predicates:
  - `chapter_of` — chapter → book
  - `verse_of` — verse → chapter
  - `mentions` — verse → concept (the dense edge type, ~150 of them)
  - `created_on` — concept → day (which day it appears on in the narrative)
  - `named_by_god` — concept → god (e.g. light called Day, firmament called
    Heaven)
  - `blessed_by` — concept → god (1:22, 1:28, 2:3)
  - `image_of` — man → god (1:27)
  - `separated_from` — light ↔ darkness (1:4)
  - `rested_on` — god → Day 7 (2:2)
  - `sanctified_by` — sabbath → god (2:3)

The graph fits comfortably in a single `POST /ops` request (~300 ops, well
under the 2,000-op cap) and uses only `@local` refs, so loading it is one
HTTP call.

## Loading

```bash
# Against a default local stack
ARKE_KEY=$ADMIN_BOOTSTRAP_KEY ./load.sh

# Against another host
ARKE_API=https://your-deploy.arkeon.tech ARKE_KEY=$YOUR_KEY ./load.sh

# Validate without writing
ARKE_KEY=$ADMIN_BOOTSTRAP_KEY ./load.sh --dry-run
```

The script POSTs `genesis-creation.ops.json` to `/ops` and pretty-prints the
response. Successful loads return ~76 created entities and ~220 created edges.

If you'd rather skip the wrapper:

```bash
curl -X POST "$ARKE_API/ops" \
  -H "X-API-Key: $ARKE_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @genesis-creation.ops.json
```

## Poking at the graph after loading

```bash
# All 34 verses, with both languages
curl "$ARKE_API/entities?type=verse&limit=50" -H "X-API-Key: $ARKE_KEY"

# The single God entity
curl "$ARKE_API/entities?type=deity" -H "X-API-Key: $ARKE_KEY"

# Every verse that mentions God (use the ULID returned by the call above)
curl "$ARKE_API/entities/{god_ulid}/relationships?predicate=mentions" \
  -H "X-API-Key: $ARKE_KEY"

# Walk the seventh-day chain
curl "$ARKE_API/entities?label=Day%207" -H "X-API-Key: $ARKE_KEY"
```

## Re-loading

The ops format deliberately does not deduplicate (see
[`docs/INGEST_OPS.md`](../../docs/INGEST_OPS.md)). Running `load.sh` twice
will produce a second copy of every entity and edge. Load it once on a fresh
deployment, or merge duplicates afterwards via the entity merge API.

## Source texts

- **Septuagint Greek**: from the public-domain Greek Wikisource edition of
  the Septuagint (`el.wikisource.org/wiki/Γένεσις`).
- **King James English**: from Project Gutenberg's KJV (PG #10).

Both source texts are public domain. The verse parsing, concept dictionary,
and relationship extraction happened once during seed construction; what
ships in this directory is the resulting envelope, not the build pipeline.

## Extending

The whole graph is one JSON file. To add more verses, more concepts, or new
predicates, edit `genesis-creation.ops.json` directly and re-POST it to a
fresh deployment. There is no build step.
