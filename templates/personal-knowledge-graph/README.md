# Personal Knowledge Graph

A template that turns an Arkeon instance into a personal knowledge graph. You add content — documents, notes, conversations, bookmarks — and two workers automatically build and maintain a relationship graph:

- **Dreamer** — analyzes new content, extracts concepts/people/observations, creates relationships. When idle, reflects on existing content to find deeper cross-document connections.
- **Tidier** — scans recent graph additions for duplicates, merges near-identical entities, removes low-quality entries, and verifies relationships.

## How It Works

1. **You add content** to a dedicated space (via CLI, SDK, or any agent with an API key)
2. **The dreamer runs** on a schedule (default: every 4 hours) and analyzes new content
3. **It extracts** concepts, people, and observations, connecting them with typed relationships
4. **The tidier runs** on an offset schedule (default: 2 hours after the dreamer) and cleans up
5. **The graph grows** over time, organizing your thinking across everything you add

## Prerequisites

- A running Arkeon instance with Redis (all deployed instances include Redis by default)
- An API key for your instance
- An LLM API key (any OpenAI-compatible provider)
- `curl`, `jq`, `python3` (with PyYAML: `pip3 install pyyaml`)

Both workers run automatically on cron schedules via the built-in BullMQ scheduler. This requires Redis, which is included in the standard docker-compose stack. No external cron or manual invocation needed.

## Setup

```bash
cd templates/personal-knowledge-graph

# 1. Copy and edit the config
cp config.example.yaml config.yaml
# Fill in your Arkeon URL, API key, LLM provider, and preferences

# 2. Run setup
./setup.sh
```

The setup script will:
- Create a space for your knowledge graph
- Create the dreamer worker (content analysis) with its state entity
- Create the tidier worker (graph maintenance) with its state entity
- Create an assistant agent with an API key you give to your AI assistant
- Output the API key and quick-start commands

## Configuration

See `config.example.yaml` for all options. Key settings:

| Setting | Description |
|---------|-------------|
| `dreamer.schedule` | Cron expression for content analysis runs |
| `dreamer.max_iterations` | Max LLM turns per dreamer run |
| `tidier.schedule` | Cron expression for maintenance runs (offset from dreamer) |
| `tidier.max_iterations` | Max LLM turns per tidier run |
| `priorities.themes` | Topics to pay extra attention to (soft hints) |
| `priorities.detail_level` | `low` / `medium` / `high` extraction detail |
| `priorities.extract_people` | Whether to extract person entities |
| `priorities.extract_concepts` | Whether to extract concept entities |

## Giving Access to Your AI Assistant

Setup creates an **assistant agent** with editor access to your knowledge graph. The API key is saved to `.env.assistant`. Give it to any AI assistant with terminal access (Claude Code, Codex, etc.):

1. Open `integration/claude-code-snippet.md`
2. Fill in the values from `.env.assistant`
3. Give the snippet to your assistant

The assistant can then add content, search the graph, and query relationships on your behalf. The dreamer and tidier workers handle all the analysis and maintenance automatically.

### Adding content directly

You can also add content yourself via the CLI:

```bash
source .env.assistant

# Add a note
arkeon entities create --type note --space-id "$ARKE_SPACE_ID" \
  --properties '{"label":"My note","content":"The actual content..."}'

# Add a document
arkeon entities create --type document --space-id "$ARKE_SPACE_ID" \
  --properties '{"label":"Paper title","content":"Full text...","source":"arxiv"}'
```

## What the Workers Do

### Dreamer (content analysis)

Extracts three types of entities from your content:

- **Concepts** — Abstract ideas, themes, and topics
- **People** — Individuals mentioned by name (if enabled)
- **Observations** — Specific claims, insights, or notable points

Connects them with typed relationships:

| Predicate | Meaning |
|-----------|---------|
| `derived_from` | Concept was derived from content |
| `mentioned_in` | Person was mentioned in content |
| `relates_to` | Concept relates to another concept |
| `supports` | Observation supports a concept |
| `contradicts` | Observation contradicts a concept |
| `observed_in` | Observation was found in content |

### Tidier (graph maintenance)

Keeps the graph clean by:

- **Merging duplicates** — entities with identical or near-identical labels
- **Removing low-quality entries** — vague concepts, trivially obvious observations
- **Verifying relationships** — ensuring every entity has proper source links

The tidier only scans entities created since its last run, so it stays fast even on large graphs.

## File Structure

```
personal-knowledge-graph/
  config.example.yaml          # Config template
  setup.sh                     # Setup script
  dreamer/
    system-prompt.md           # Dreamer's system prompt (editable)
    scheduled-prompt.md        # Prompt sent on each dreamer cron tick
  tidier/
    system-prompt.md           # Tidier's system prompt (editable)
    scheduled-prompt.md        # Prompt sent on each tidier cron tick
  integration/
    claude-code-snippet.md     # Integration instructions for agents
```

## Customizing the Workers

Both workers' behavior is driven by their `system-prompt.md` files. You can edit these before running setup to change:

- What entity types are created (dreamer)
- What relationship predicates are used (dreamer)
- How deduplication works (dreamer + tidier)
- Merge/delete thresholds (tidier)

After setup, update a worker's system prompt via the API:
```bash
arkeon workers update <WORKER_ID> --system-prompt "$(cat dreamer/system-prompt.md)"
```
