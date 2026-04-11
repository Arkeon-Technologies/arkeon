# Arkeon Knowledge Graph — Assistant Integration

Give these instructions to Claude Code, Codex, or any AI assistant with terminal access.

---

## Setup

```bash
# Install the Arkeon CLI
npm install -g arkeon

# Configure connection (values from .env.assistant)
export ARKE_API_URL="{{API_URL}}"
export ARKE_API_KEY="{{ASSISTANT_KEY}}"
export ARKE_SPACE_ID="{{SPACE_ID}}"

arkeon config set-url "$ARKE_API_URL"
arkeon auth set-api-key "$ARKE_API_KEY"
arkeon config set-space "$ARKE_SPACE_ID"
```

## Adding Content

You have access to a personal knowledge graph via the Arkeon API. When the user asks you to save, remember, or add something to their knowledge graph, use these commands.

### Add a note
```bash
arkeon entities create --type note \
  --properties '{"label":"<title>","content":"<content>"}' \
  --space-id "$ARKE_SPACE_ID"
```

### Add a document
```bash
arkeon entities create --type document \
  --properties '{"label":"<title>","content":"<full text>","source":"<where it came from>"}' \
  --space-id "$ARKE_SPACE_ID"
```

### Add a conversation excerpt
```bash
arkeon entities create --type conversation \
  --properties '{"label":"<topic>","content":"<conversation text>","participants":"<who was involved>"}' \
  --space-id "$ARKE_SPACE_ID"
```

### Add a bookmark or reference
```bash
arkeon entities create --type reference \
  --properties '{"label":"<title>","url":"<url>","summary":"<why this matters>"}' \
  --space-id "$ARKE_SPACE_ID"
```

## Reading the Knowledge Graph

### Search for something
```bash
arkeon search query --q "<search terms>" --space-id "$ARKE_SPACE_ID"
```

### List recent content
```bash
arkeon entities list --space-id "$ARKE_SPACE_ID" --sort created_at --order desc --limit 20
```

### List concepts the dreamer has extracted
```bash
arkeon entities list --space-id "$ARKE_SPACE_ID" --filter "type:concept" --sort created_at --order desc
```

### See how an entity connects to others
```bash
arkeon entities get <ENTITY_ID> --view expanded --rel-limit 20
```

### List relationships
```bash
arkeon relationships list <ENTITY_ID>
```

## What You Can Do

You have **editor** access to the knowledge graph space. This means you can:

- **Add content** — notes, documents, conversations, references
- **Read everything** — all entities, concepts, observations, relationships
- **Search** — full-text and semantic search across the graph
- **Query relationships** — see how entities connect to each other

You do **not** need to create relationships manually — a dreamer worker automatically analyzes new content and builds connections. A tidier worker periodically merges duplicates and cleans up the graph.

## Tips

- Use descriptive labels and include as much content as useful. The dreamer works better with more context.
- Everything you add goes into a dedicated space and is organized automatically.
- When the user asks "what do I know about X?", search the graph first before answering.
- When the user shares something interesting, offer to add it to the knowledge graph.
