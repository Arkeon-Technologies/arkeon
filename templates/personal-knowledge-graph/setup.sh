#!/usr/bin/env bash
set -euo pipefail

# ── Personal Knowledge Graph Setup ──────────────────────────────────
# Creates a space, dreamer worker, tidier worker, and integration
# agent for your personal knowledge graph on an Arkeon instance.
#
# Requirements: curl, jq, python3
# Usage: ./setup.sh [path/to/config.yaml]
# ────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${1:-${SCRIPT_DIR}/config.yaml}"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: Config file not found: $CONFIG_FILE"
  echo "Copy config.example.yaml to config.yaml and fill in your values."
  exit 1
fi

# ── Parse YAML config with Python ───────────────────────────────────
echo "Reading config from $CONFIG_FILE..."

PARSED_CONFIG=$(mktemp)
trap "rm -f $PARSED_CONFIG" EXIT

python3 - "$CONFIG_FILE" "$PARSED_CONFIG" <<'PYEOF'
import yaml, sys, json

with open(sys.argv[1]) as f:
    c = yaml.safe_load(f)

out = sys.argv[2]

def q(v):
    s = str(v)
    return s.replace("\\", "\\\\").replace('"', '\\"')

a = c.get("arkeon", {})
s = c.get("space", {})
l = c.get("llm", {})
# Support both "dreamer" key and legacy "worker" key
d = c.get("dreamer", c.get("worker", {}))
t = c.get("tidier", {})
p = c.get("priorities", {})

lines = []
lines.append(f'API_URL="{q(a.get("api_url", ""))}"')
lines.append(f'API_KEY="{q(a.get("api_key", ""))}"')
lines.append(f'SPACE_NAME="{q(s.get("name", "My Knowledge Graph"))}"')
lines.append(f'SPACE_DESC="{q(s.get("description", ""))}"')
lines.append(f'LLM_BASE_URL="{q(l.get("base_url", ""))}"')
lines.append(f'LLM_API_KEY="{q(l.get("api_key", ""))}"')
lines.append(f'LLM_MODEL="{q(l.get("model", ""))}"')

# Dreamer config
lines.append(f'DREAMER_NAME="{q(d.get("name", "dreamer"))}"')
lines.append(f'DREAMER_SCHEDULE="{q(d.get("schedule", "0 */4 * * *"))}"')
lines.append(f'DREAMER_MAX_ITER={d.get("max_iterations", 30)}')

# Tidier config
lines.append(f'TIDIER_NAME="{q(t.get("name", "tidier"))}"')
lines.append(f'TIDIER_SCHEDULE="{q(t.get("schedule", "0 2-22/4 * * *"))}"')
lines.append(f'TIDIER_MAX_ITER={t.get("max_iterations", 15)}')

themes = p.get("themes", [])
lines.append(f'PRIORITIES_THEMES={json.dumps(json.dumps(themes))}')
lines.append(f'PRIORITIES_DETAIL="{q(p.get("detail_level", "medium"))}"')
lines.append(f'PRIORITIES_PEOPLE={"true" if p.get("extract_people", True) else "false"}')
lines.append(f'PRIORITIES_CONCEPTS={"true" if p.get("extract_concepts", True) else "false"}')

with open(out, "w") as f:
    f.write("\n".join(lines) + "\n")
PYEOF

source "$PARSED_CONFIG"

# ── Validate required fields ────────────────────────────────────────
fail=0
for var in API_URL API_KEY LLM_BASE_URL LLM_API_KEY LLM_MODEL SPACE_NAME; do
  if [ -z "${!var}" ]; then
    echo "Error: Missing required config field: $var"
    fail=1
  fi
done
[ $fail -eq 1 ] && exit 1

# Helper for API calls
api() {
  local method="$1" path="$2"
  shift 2
  curl -sf -X "$method" "${API_URL}${path}" \
    -H "Authorization: ApiKey ${API_KEY}" \
    -H "Content-Type: application/json" \
    "$@"
}

# ── Step 1: Verify connectivity ─────────────────────────────────────
echo ""
echo "Verifying API connection..."
ME=$(api GET /auth/me) || { echo "Error: Cannot connect to ${API_URL}. Check api_url and api_key."; exit 1; }

ACTOR_ID=$(echo "$ME" | jq -r '.actor.id')
ARKE_ID=$(echo "$ME" | jq -r '.actor.arke_id // empty')
# Properties may be returned as a JSON string or object
ACTOR_NAME=$(echo "$ME" | jq -r '(.actor.properties | if type == "string" then fromjson else . end) .label // .name // "unnamed"')
echo "  Authenticated as: ${ACTOR_NAME} (${ACTOR_ID})"

# If actor has no arke_id (e.g. bootstrap admin), discover it from /arkes
if [ -z "$ARKE_ID" ] || [ "$ARKE_ID" = "null" ]; then
  echo "  Actor has no arke_id, discovering from /arkes..."
  ARKES=$(api GET /arkes) || { echo "Error: Failed to list arkes."; exit 1; }
  ARKE_ID=$(echo "$ARKES" | jq -r '.arkes[0].id // empty')
  if [ -z "$ARKE_ID" ]; then
    echo "Error: No arkes found on this instance."
    exit 1
  fi
fi
echo "  Arke: ${ARKE_ID}"

# ── Step 2: Create space ────────────────────────────────────────────
echo ""
echo "Creating space: ${SPACE_NAME}..."
SPACE_BODY=$(jq -n \
  --arg name "$SPACE_NAME" \
  --arg desc "$SPACE_DESC" \
  --arg arke "$ARKE_ID" \
  '{name: $name, description: $desc, arke_id: $arke}')

SPACE_RESP=$(api POST /spaces -d "$SPACE_BODY") || { echo "Error: Failed to create space."; exit 1; }
SPACE_ID=$(echo "$SPACE_RESP" | jq -r '.space.id')
echo "  Space created: ${SPACE_ID}"

# ── Step 3: Create state entities ───────────────────────────────────
echo ""
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo "Creating dreamer state entity..."
DREAMER_STATE_BODY=$(jq -n \
  --arg now "$NOW" \
  --arg space "$SPACE_ID" \
  --arg arke "$ARKE_ID" \
  '{
    type: "dreamer_state",
    arke_id: $arke,
    space_id: $space,
    properties: {
      label: "Dreamer State",
      last_processed_at: $now,
      run_count: 0
    }
  }')

DREAMER_STATE_RESP=$(api POST /entities -d "$DREAMER_STATE_BODY") || { echo "Error: Failed to create dreamer state entity."; exit 1; }
DREAMER_STATE_ID=$(echo "$DREAMER_STATE_RESP" | jq -r '.entity.id')
echo "  Dreamer state: ${DREAMER_STATE_ID}"

echo "Creating tidier state entity..."
TIDIER_STATE_BODY=$(jq -n \
  --arg now "$NOW" \
  --arg space "$SPACE_ID" \
  --arg arke "$ARKE_ID" \
  '{
    type: "tidier_state",
    arke_id: $arke,
    space_id: $space,
    properties: {
      label: "Tidier State",
      last_processed_at: $now,
      run_count: 0
    }
  }')

TIDIER_STATE_RESP=$(api POST /entities -d "$TIDIER_STATE_BODY") || { echo "Error: Failed to create tidier state entity."; exit 1; }
TIDIER_STATE_ID=$(echo "$TIDIER_STATE_RESP" | jq -r '.entity.id')
echo "  Tidier state:  ${TIDIER_STATE_ID}"

# ── Step 4: Build system prompts ────────────────────────────────────
echo ""
echo "Building dreamer system prompt..."

# Build priorities block
PRIORITIES_BLOCK=""
if [ "$PRIORITIES_THEMES" != "[]" ]; then
  THEME_LIST=$(echo "$PRIORITIES_THEMES" | jq -r '.[] | "- " + .')
  PRIORITIES_BLOCK="### Focus Themes
Pay extra attention to these topics (but still extract other themes you discover):
${THEME_LIST}

"
fi

PRIORITIES_BLOCK="${PRIORITIES_BLOCK}### Detail Level: ${PRIORITIES_DETAIL}
"
case "$PRIORITIES_DETAIL" in
  low)
    PRIORITIES_BLOCK="${PRIORITIES_BLOCK}Extract only major, high-level themes. Skip minor details, individual people, and specific claims. Focus on the big picture."
    ;;
  medium)
    PRIORITIES_BLOCK="${PRIORITIES_BLOCK}Extract themes, key people, and notable claims or insights. Balance breadth and depth."
    ;;
  high)
    PRIORITIES_BLOCK="${PRIORITIES_BLOCK}Extract everything: themes, sub-themes, people, specific claims, temporal observations, and fine-grained connections. Be thorough."
    ;;
esac

PRIORITIES_BLOCK="${PRIORITIES_BLOCK}

### Entity Extraction"
if [ "$PRIORITIES_PEOPLE" = "true" ]; then
  PRIORITIES_BLOCK="${PRIORITIES_BLOCK}
- Extract **person** entities when people are mentioned by name."
else
  PRIORITIES_BLOCK="${PRIORITIES_BLOCK}
- Do NOT extract person entities. Focus on concepts and ideas only."
fi
if [ "$PRIORITIES_CONCEPTS" = "true" ]; then
  PRIORITIES_BLOCK="${PRIORITIES_BLOCK}
- Extract **concept** entities for significant ideas, themes, and topics."
else
  PRIORITIES_BLOCK="${PRIORITIES_BLOCK}
- Do NOT extract concept entities. Focus on observations and direct relationships only."
fi

# Read and interpolate dreamer system prompt
DREAMER_SYSTEM_PROMPT=$(cat "${SCRIPT_DIR}/dreamer/system-prompt.md")
DREAMER_SYSTEM_PROMPT="${DREAMER_SYSTEM_PROMPT//\{\{SPACE_ID\}\}/${SPACE_ID}}"
DREAMER_SYSTEM_PROMPT="${DREAMER_SYSTEM_PROMPT//\{\{STATE_ENTITY_ID\}\}/${DREAMER_STATE_ID}}"
DREAMER_SYSTEM_PROMPT="${DREAMER_SYSTEM_PROMPT//\{\{PRIORITIES_BLOCK\}\}/${PRIORITIES_BLOCK}}"

DREAMER_SCHEDULED_PROMPT=$(cat "${SCRIPT_DIR}/dreamer/scheduled-prompt.md")
DREAMER_SCHEDULED_PROMPT="${DREAMER_SCHEDULED_PROMPT//\{\{SPACE_ID\}\}/${SPACE_ID}}"

echo "Building tidier system prompt..."

# Read and interpolate tidier system prompt
TIDIER_SYSTEM_PROMPT=$(cat "${SCRIPT_DIR}/tidier/system-prompt.md")
TIDIER_SYSTEM_PROMPT="${TIDIER_SYSTEM_PROMPT//\{\{SPACE_ID\}\}/${SPACE_ID}}"
TIDIER_SYSTEM_PROMPT="${TIDIER_SYSTEM_PROMPT//\{\{TIDIER_STATE_ENTITY_ID\}\}/${TIDIER_STATE_ID}}"

TIDIER_SCHEDULED_PROMPT=$(cat "${SCRIPT_DIR}/tidier/scheduled-prompt.md")
TIDIER_SCHEDULED_PROMPT="${TIDIER_SCHEDULED_PROMPT//\{\{SPACE_ID\}\}/${SPACE_ID}}"

# ── Step 5: Create workers ──────────────────────────────────────────

# Helper to create a worker with schedule fallback
create_worker() {
  local name="$1" system_prompt="$2" schedule="$3" scheduled_prompt="$4" max_iter="$5"

  local body
  body=$(jq -n \
    --arg name "$name" \
    --arg prompt "$system_prompt" \
    --arg sched "$schedule" \
    --arg sched_prompt "$scheduled_prompt" \
    --arg base_url "$LLM_BASE_URL" \
    --arg api_key "$LLM_API_KEY" \
    --arg model "$LLM_MODEL" \
    --arg arke "$ARKE_ID" \
    --argjson max_iter "$max_iter" \
    '{
      kind: "worker",
      arke_id: $arke,
      name: $name,
      system_prompt: $prompt,
      schedule: $sched,
      scheduled_prompt: $sched_prompt,
      max_iterations: $max_iter,
      llm: {
        base_url: $base_url,
        api_key: $api_key,
        model: $model
      }
    }')

  local resp
  resp=$(api POST /actors -d "$body" 2>/dev/null)
  if [ $? -ne 0 ]; then
    echo "  Schedule failed (Redis may not be configured). Creating without schedule..."
    body=$(echo "$body" | jq 'del(.schedule, .scheduled_prompt)')
    resp=$(api POST /actors -d "$body") || { echo "Error: Failed to create worker ${name}."; exit 1; }
    echo "  Created without schedule — invoke manually or add schedule later."
  fi

  echo "$resp"
}

# Helper to grant worker permissions
grant_worker_perms() {
  local worker_id="$1" state_entity_id="$2"

  # Admin + full clearance so it can create/modify relationships across the space
  api PUT "/actors/${worker_id}" -d '{"max_read_level":4,"max_write_level":4,"is_admin":true}' > /dev/null 2>&1 || true

  # Editor on space
  local perm_body
  perm_body=$(jq -n --arg id "$worker_id" '{grantee_type: "actor", grantee_id: $id, role: "editor"}')
  api POST "/spaces/${SPACE_ID}/permissions" -d "$perm_body" > /dev/null 2>&1 || true

  # Editor on its state entity
  api POST "/entities/${state_entity_id}/permissions" -d "$perm_body" > /dev/null 2>&1 || true
}

echo ""
echo "Creating dreamer worker: ${DREAMER_NAME}..."
DREAMER_RESP=$(create_worker "$DREAMER_NAME" "$DREAMER_SYSTEM_PROMPT" "$DREAMER_SCHEDULE" "$DREAMER_SCHEDULED_PROMPT" "$DREAMER_MAX_ITER")
DREAMER_WORKER_ID=$(echo "$DREAMER_RESP" | jq -r '.actor.id')
echo "  Dreamer worker: ${DREAMER_WORKER_ID}"
grant_worker_perms "$DREAMER_WORKER_ID" "$DREAMER_STATE_ID"
echo "  Granted dreamer space editor + state entity access"

echo ""
echo "Creating tidier worker: ${TIDIER_NAME}..."
TIDIER_RESP=$(create_worker "$TIDIER_NAME" "$TIDIER_SYSTEM_PROMPT" "$TIDIER_SCHEDULE" "$TIDIER_SCHEDULED_PROMPT" "$TIDIER_MAX_ITER")
TIDIER_WORKER_ID=$(echo "$TIDIER_RESP" | jq -r '.actor.id')
echo "  Tidier worker:  ${TIDIER_WORKER_ID}"
grant_worker_perms "$TIDIER_WORKER_ID" "$TIDIER_STATE_ID"
echo "  Granted tidier space editor + state entity access"

# ── Step 6: Create integration agent ────────────────────────────────
echo ""
echo "Creating integration agent..."
AGENT_BODY=$(jq -n \
  --arg arke "$ARKE_ID" \
  '{
    kind: "agent",
    arke_id: $arke,
    max_read_level: 1,
    max_write_level: 1,
    properties: { name: "knowledge-graph-ingest" }
  }')

AGENT_RESP=$(api POST /actors -d "$AGENT_BODY") || { echo "Error: Failed to create integration agent."; exit 1; }
INTEGRATION_KEY=$(echo "$AGENT_RESP" | jq -r '.api_key')
AGENT_ID=$(echo "$AGENT_RESP" | jq -r '.actor.id')
echo "  Agent created: ${AGENT_ID}"

# Grant contributor access to the space
PERM_BODY=$(jq -n \
  --arg id "$AGENT_ID" \
  '{grantee_type: "actor", grantee_id: $id, role: "contributor"}')

api POST "/spaces/${SPACE_ID}/permissions" -d "$PERM_BODY" > /dev/null || {
  echo "Warning: Failed to grant space permissions to integration agent."
}
echo "  Granted contributor access to space"

# ── Step 7: Output summary ──────────────────────────────────────────
echo ""
echo "=========================================="
echo "  Knowledge Graph Setup Complete"
echo "=========================================="
echo ""
echo "  Space ID:           ${SPACE_ID}"
echo "  Space Name:         ${SPACE_NAME}"
echo ""
echo "  Dreamer Worker ID:  ${DREAMER_WORKER_ID}"
echo "  Dreamer Schedule:   ${DREAMER_SCHEDULE}"
echo "  Dreamer State:      ${DREAMER_STATE_ID}"
echo ""
echo "  Tidier Worker ID:   ${TIDIER_WORKER_ID}"
echo "  Tidier Schedule:    ${TIDIER_SCHEDULE}"
echo "  Tidier State:       ${TIDIER_STATE_ID}"
echo ""
echo "  Integration Key:    ${INTEGRATION_KEY}"
echo "  (Save this key — it will not be shown again)"
echo ""
echo "=========================================="
echo ""

# Write .env.integration file
ENV_FILE="${SCRIPT_DIR}/.env.integration"
cat > "$ENV_FILE" <<EOF
# Arkeon Knowledge Graph Integration
# Generated $(date -u +"%Y-%m-%dT%H:%M:%SZ")
ARKE_API_URL=${API_URL}
ARKE_API_KEY=${INTEGRATION_KEY}
ARKE_SPACE_ID=${SPACE_ID}
ARKE_DREAMER_WORKER_ID=${DREAMER_WORKER_ID}
ARKE_TIDIER_WORKER_ID=${TIDIER_WORKER_ID}
EOF
echo "Integration env written to: ${ENV_FILE}"

# Print quick-start commands
echo ""
echo "-- Quick Start --"
echo ""
echo "Add a note:"
echo "  export ARKE_API_URL=\"${API_URL}\""
echo "  export ARKE_API_KEY=\"${INTEGRATION_KEY}\""
echo "  arkeon entities create --type note --space-id ${SPACE_ID} \\"
echo "    --properties '{\"label\":\"My first note\",\"content\":\"Hello, knowledge graph!\"}'"
echo ""
echo "Give an agent access (copy the integration snippet):"
echo "  cat ${SCRIPT_DIR}/integration/claude-code-snippet.md"
echo ""
echo "Manually trigger the dreamer:"
echo "  curl -X POST \"${API_URL}/workers/${DREAMER_WORKER_ID}/invoke\" \\"
echo "    -H \"Authorization: ApiKey ${API_KEY}\" \\"
echo "    -H \"Content-Type: application/json\" \\"
echo "    -d '{\"prompt\":\"$(echo "$DREAMER_SCHEDULED_PROMPT" | head -1)\"}'"
echo ""
echo "Manually trigger the tidier:"
echo "  curl -X POST \"${API_URL}/workers/${TIDIER_WORKER_ID}/invoke\" \\"
echo "    -H \"Authorization: ApiKey ${API_KEY}\" \\"
echo "    -H \"Content-Type: application/json\" \\"
echo "    -d '{\"prompt\":\"$(echo "$TIDIER_SCHEDULED_PROMPT" | head -1)\"}'"
echo ""
