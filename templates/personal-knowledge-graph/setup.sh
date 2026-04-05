#!/usr/bin/env bash
set -euo pipefail

# ── Personal Knowledge Graph Setup ──────────────────────────────────
# Creates a space, dreamer worker, and integration agent for your
# personal knowledge graph on an Arkeon instance.
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
w = c.get("worker", {})
p = c.get("priorities", {})

lines = []
lines.append(f'API_URL="{q(a.get("api_url", ""))}"')
lines.append(f'API_KEY="{q(a.get("api_key", ""))}"')
lines.append(f'SPACE_NAME="{q(s.get("name", "My Knowledge Graph"))}"')
lines.append(f'SPACE_DESC="{q(s.get("description", ""))}"')
lines.append(f'LLM_BASE_URL="{q(l.get("base_url", ""))}"')
lines.append(f'LLM_API_KEY="{q(l.get("api_key", ""))}"')
lines.append(f'LLM_MODEL="{q(l.get("model", ""))}"')
lines.append(f'WORKER_NAME="{q(w.get("name", "dreamer"))}"')
lines.append(f'WORKER_SCHEDULE="{q(w.get("schedule", "*/5 * * * *"))}"')
lines.append(f'WORKER_MAX_ITER={w.get("max_iterations", 30)}')

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

# ── Step 3: Create dreamer state entity ─────────────────────────────
echo ""
echo "Creating dreamer state entity..."
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
STATE_BODY=$(jq -n \
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

STATE_RESP=$(api POST /entities -d "$STATE_BODY") || { echo "Error: Failed to create state entity."; exit 1; }
STATE_ENTITY_ID=$(echo "$STATE_RESP" | jq -r '.entity.id')
STATE_VER=$(echo "$STATE_RESP" | jq -r '.entity.ver')
echo "  State entity: ${STATE_ENTITY_ID} (ver ${STATE_VER})"

# ── Step 4: Build system prompt ─────────────────────────────────────
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

# Read and interpolate system prompt template
SYSTEM_PROMPT=$(cat "${SCRIPT_DIR}/dreamer/system-prompt.md")
SYSTEM_PROMPT="${SYSTEM_PROMPT//\{\{SPACE_ID\}\}/${SPACE_ID}}"
SYSTEM_PROMPT="${SYSTEM_PROMPT//\{\{STATE_ENTITY_ID\}\}/${STATE_ENTITY_ID}}"
SYSTEM_PROMPT="${SYSTEM_PROMPT//\{\{PRIORITIES_BLOCK\}\}/${PRIORITIES_BLOCK}}"

# Read and interpolate scheduled prompt
SCHEDULED_PROMPT=$(cat "${SCRIPT_DIR}/dreamer/scheduled-prompt.md")
SCHEDULED_PROMPT="${SCHEDULED_PROMPT//\{\{SPACE_ID\}\}/${SPACE_ID}}"

# ── Step 5: Create dreamer worker ───────────────────────────────────
echo "Creating dreamer worker: ${WORKER_NAME}..."
WORKER_BODY=$(jq -n \
  --arg name "$WORKER_NAME" \
  --arg prompt "$SYSTEM_PROMPT" \
  --arg sched "$WORKER_SCHEDULE" \
  --arg sched_prompt "$SCHEDULED_PROMPT" \
  --arg base_url "$LLM_BASE_URL" \
  --arg api_key "$LLM_API_KEY" \
  --arg model "$LLM_MODEL" \
  --arg arke "$ARKE_ID" \
  --argjson max_iter "$WORKER_MAX_ITER" \
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

# Try with schedule first; if Redis is unavailable, retry without schedule
WORKER_RESP=$(api POST /actors -d "$WORKER_BODY" 2>/dev/null)
if [ $? -ne 0 ]; then
  echo "  Schedule failed (Redis may not be configured). Creating worker without schedule..."
  WORKER_BODY=$(echo "$WORKER_BODY" | jq 'del(.schedule, .scheduled_prompt)')
  WORKER_RESP=$(api POST /actors -d "$WORKER_BODY") || {
    echo "Error: Failed to create dreamer worker."
    exit 1
  }
  echo "  Worker created without schedule — invoke manually or add schedule later."
  HAS_SCHEDULE=false
else
  HAS_SCHEDULE=true
fi

WORKER_ID=$(echo "$WORKER_RESP" | jq -r '.actor.id')
echo "  Worker created: ${WORKER_ID}"

# Grant worker admin + full clearance so it can create relationships from any entity in the space
api PUT "/actors/${WORKER_ID}" -d '{"max_read_level":4,"max_write_level":4,"is_admin":true}' > /dev/null 2>&1 || true

WPERM_BODY=$(jq -n --arg id "$WORKER_ID" '{grantee_type: "actor", grantee_id: $id, role: "editor"}')
api POST "/spaces/${SPACE_ID}/permissions" -d "$WPERM_BODY" > /dev/null 2>&1 || true

# Grant worker edit access to the state entity so it can update its checkpoint
SPENT_BODY=$(jq -n --arg id "$WORKER_ID" '{grantee_type: "actor", grantee_id: $id, role: "editor"}')
api POST "/entities/${STATE_ENTITY_ID}/permissions" -d "$SPENT_BODY" > /dev/null 2>&1 || true
echo "  Granted worker space editor + state entity access"

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
echo "  Space ID:         ${SPACE_ID}"
echo "  Space Name:       ${SPACE_NAME}"
echo "  Worker ID:        ${WORKER_ID}"
echo "  Worker Schedule:  ${WORKER_SCHEDULE}"
echo "  State Entity:     ${STATE_ENTITY_ID}"
echo ""
echo "  Integration Key:  ${INTEGRATION_KEY}"
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
ARKE_WORKER_ID=${WORKER_ID}
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
echo "  curl -X POST \"${API_URL}/workers/${WORKER_ID}/invoke\" \\"
echo "    -H \"Authorization: ApiKey ${API_KEY}\" \\"
echo "    -H \"Content-Type: application/json\" \\"
echo "    -d '{\"prompt\":\"${SCHEDULED_PROMPT}\"}'"
echo ""
