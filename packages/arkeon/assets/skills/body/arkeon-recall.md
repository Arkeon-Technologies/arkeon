# Arkeon Recall

Pull knowledge from the Arkeon graph into this conversation. Use this when you need structured context about a topic before answering questions or making decisions.

## Input

`$ARGUMENTS` contains the topic or query to recall (e.g., "neuroscience", "authentication flow", "John Smith").

If `$ARGUMENTS` is empty, ask the user what topic they want to recall.

## Protocol

### 1. Check stack is running

```bash
arkeon status
```

If the stack is not running, tell the user to run `arkeon start` and stop here.

Parse the `api_url` from the output for use in later steps.

### 2. Search the graph

```bash
arkeon search query --q "$ARGUMENTS" --limit 20
```

Parse the results. If no results found, report:

> No knowledge found for "$ARGUMENTS" in the graph.

Then suggest: try different search terms, or use `/arkeon-ingest` to add documents first. Stop here.

If results are found, note the top 5 entity IDs, labels, types, and descriptions.

### 3. Traverse from top results

For each of the top 3 search results, explore their neighborhood:

```bash
arkeon graph traverse --source id:<entity_id> --hops 2 --limit 15
```

This returns connected entities within 2 hops. Collect all unique entities and relationships from traversal results. Deduplicate entities that appear in multiple traversals.

### 4. Compile the knowledge brief

Synthesize the search results and traversal data into a structured brief:

```
## Knowledge Brief: {topic}

### Key Entities

| Entity | Type | Description | ID |
|--------|------|-------------|-----|
| {label} | {type} | {description} | {id} |

### Relationships

- {source_label} --{predicate}--> {target_label}
- ...

### Context

{1-2 paragraph synthesis of what the graph knows about this topic,
 connecting the dots between entities and explaining their significance}

---
{N} entities, {M} relationships recalled from the graph.
Use entity IDs above for follow-up: `arkeon entities get <id>`
```

### 5. Offer follow-up

After presenting the brief, suggest:

- Specific entities the user might want to explore deeper
- Related topics that appeared in traversal but were not in the original query
- Whether any of this context changes how you would approach the user's current task
