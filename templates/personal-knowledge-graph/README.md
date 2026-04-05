# Personal Knowledge Graph

A template that turns an Arkeon instance into a personal knowledge graph. You add content — documents, notes, conversations, bookmarks — and a dreamer worker automatically analyzes it, extracts concepts and themes, and builds a relationship graph connecting everything.

## How It Works

1. **You add content** to a dedicated space (via CLI, SDK, or any agent with an API key)
2. **The dreamer runs** on a schedule (default: every 5 minutes) and checks for new content
3. **It extracts** concepts, people, and observations from what you added
4. **It connects** new content to existing graph nodes via typed relationships
5. **The graph grows** over time, organizing your thinking across everything you add

## Prerequisites

- A running Arkeon instance with Redis (all deployed instances include Redis by default)
- An API key for your instance
- An LLM API key (any OpenAI-compatible provider)
- `curl`, `jq`, `python3` (with PyYAML: `pip3 install pyyaml`)

The dreamer runs automatically on a cron schedule via the built-in BullMQ scheduler. This requires Redis, which is included in the standard docker-compose stack. No external cron or manual invocation needed — once setup completes, the dreamer starts running on its configured schedule.

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
- Create the dreamer worker with your configured schedule and priorities
- Create a scoped integration agent for external access
- Output an API key and quick-start commands

## Configuration

See `config.example.yaml` for all options. Key settings:

| Setting | Description |
|---------|-------------|
| `worker.schedule` | Cron expression for how often the dreamer runs |
| `worker.max_iterations` | Max LLM turns per dreamer run |
| `priorities.themes` | Topics to pay extra attention to (soft hints) |
| `priorities.detail_level` | `low` / `medium` / `high` extraction detail |
| `priorities.extract_people` | Whether to extract person entities |
| `priorities.extract_concepts` | Whether to extract concept entities |

## Adding Content

After setup, add content using the integration API key:

```bash
# Source the generated env file
source .env.integration

# Add a note
arkeon entities create --type note --space-id "$ARKE_SPACE_ID" \
  --properties '{"label":"My note","content":"The actual content..."}'

# Add a document
arkeon entities create --type document --space-id "$ARKE_SPACE_ID" \
  --properties '{"label":"Paper title","content":"Full text...","source":"arxiv"}'
```

## Integrating with Agents

The setup generates an integration API key scoped to the knowledge graph space. Give it to any agent with shell access:

1. Open `integration/claude-code-snippet.md`
2. Replace the placeholder values with those from `.env.integration`
3. Give the snippet to Claude Code, Claude Co-work, or any other agent

The agent can then add content and query the knowledge graph on your behalf.

## What the Dreamer Creates

The dreamer extracts three types of entities:

- **Concepts** — Abstract ideas, themes, and topics found in your content
- **People** — Individuals mentioned by name (if enabled)
- **Observations** — Specific claims, insights, or notable points

It connects them with typed relationships:

| Predicate | Meaning |
|-----------|---------|
| `discusses` | Content discusses a concept |
| `mentions` | Content mentions a person |
| `relates_to` | Concept relates to another concept |
| `supports` | Observation supports a concept |
| `contradicts` | Observation contradicts a concept |
| `derived_from` | Concept was derived from content |

## File Structure

```
personal-knowledge-graph/
  config.example.yaml          # Config template
  setup.sh                     # Setup script
  dreamer/
    system-prompt.md           # Dreamer's system prompt (editable)
    scheduled-prompt.md        # Prompt sent on each cron tick
  integration/
    claude-code-snippet.md     # Integration instructions for agents
```

## Customizing the Dreamer

The dreamer's behavior is driven by `dreamer/system-prompt.md`. You can edit this file before running setup to change:

- What entity types it creates
- What relationship predicates it uses
- How it handles deduplication
- How many entities it creates per run

After setup, you can update the worker's system prompt via the API:
```bash
arkeon workers update <WORKER_ID> --system-prompt "$(cat dreamer/system-prompt.md)"
```
