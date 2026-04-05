# Arkeon Knowledge Graph Integration

Give these instructions to Claude Code, Claude Co-work, or any agent with shell access.

---

## Setup

```bash
# Install the Arkeon CLI
npm install -g @arkeon-technologies/cli

# Configure connection (values from setup.sh output)
export ARKE_API_URL="{{API_URL}}"
export ARKE_API_KEY="{{INTEGRATION_KEY}}"
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
arkeon entities list --space-id "$ARKE_SPACE_ID" --filter "type=concept" --sort created_at --order desc
```

### See how an entity connects to others
```bash
arkeon relationships list <ENTITY_ID>
```

## Notes

- A **dreamer** worker automatically processes new content and builds connections in the graph.
- A **tidier** worker periodically merges duplicates and removes low-quality entities.
- You do not need to create relationships manually — the dreamer handles that.
- Use descriptive labels and include as much content as useful. The dreamer works better with more context.
- Everything you add goes into a dedicated space and is organized automatically.
