#!/usr/bin/env bash
set -euo pipefail

# ── Create Assistant Agent ──────────────────────────────────────────
# Creates a new assistant agent with editor access to your knowledge
# graph space. Give the API key to Claude Code, Codex, or any AI
# assistant with terminal access.
#
# Usage:
#   ./create-assistant.sh <api_url> <api_key> <space_id> [name]
#
# Example:
#   ./create-assistant.sh https://my-instance.arkeon.tech ak_... 01ABC... "claude-code"
#
# The API key is printed once and saved to .env.assistant — save it,
# it cannot be retrieved later.
# ────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ $# -lt 3 ]; then
  echo "Usage: ./create-assistant.sh <api_url> <api_key> <space_id> [name]"
  echo ""
  echo "  api_url   - Your Arkeon instance URL"
  echo "  api_key   - Your admin API key"
  echo "  space_id  - The knowledge graph space ID (from setup.sh output)"
  echo "  name      - Optional name for the agent (default: knowledge-graph-assistant)"
  exit 1
fi

API_URL="$1"
API_KEY="$2"
SPACE_ID="$3"
AGENT_NAME="${4:-knowledge-graph-assistant}"

api() {
  local method="$1" path="$2"
  shift 2
  curl -sf -X "$method" "${API_URL}${path}" \
    -H "Authorization: ApiKey ${API_KEY}" \
    -H "Content-Type: application/json" \
    "$@"
}

# Verify connectivity
echo "Verifying connection..."
ME=$(api GET /auth/me) || { echo "Error: Cannot connect to ${API_URL}. Check your URL and API key."; exit 1; }
ARKE_ID=$(echo "$ME" | jq -r '.actor.arke_id // empty')

if [ -z "$ARKE_ID" ] || [ "$ARKE_ID" = "null" ]; then
  ARKES=$(api GET /arkes) || { echo "Error: Failed to list arkes."; exit 1; }
  ARKE_ID=$(echo "$ARKES" | jq -r '.arkes[0].id // empty')
fi

# Verify space exists
api GET "/spaces/${SPACE_ID}" > /dev/null 2>&1 || {
  echo "Error: Space ${SPACE_ID} not found. Check your space ID."
  exit 1
}

# Create assistant agent
echo "Creating assistant agent: ${AGENT_NAME}..."
AGENT_BODY=$(jq -n \
  --arg arke "$ARKE_ID" \
  --arg name "$AGENT_NAME" \
  '{
    kind: "agent",
    arke_id: $arke,
    max_read_level: 4,
    max_write_level: 2,
    properties: { name: $name }
  }')

AGENT_RESP=$(api POST /actors -d "$AGENT_BODY") || { echo "Error: Failed to create agent."; exit 1; }
ASSISTANT_KEY=$(echo "$AGENT_RESP" | jq -r '.api_key')
AGENT_ID=$(echo "$AGENT_RESP" | jq -r '.actor.id')

# Grant editor access to the space
PERM_BODY=$(jq -n --arg id "$AGENT_ID" '{grantee_type: "actor", grantee_id: $id, role: "editor"}')
api POST "/spaces/${SPACE_ID}/permissions" -d "$PERM_BODY" > /dev/null || {
  echo "Warning: Failed to grant space permissions."
}

# Output
echo ""
echo "=========================================="
echo "  Assistant Agent Created"
echo "=========================================="
echo ""
echo "  Agent ID:      ${AGENT_ID}"
echo "  Agent Name:    ${AGENT_NAME}"
echo "  API Key:       ${ASSISTANT_KEY}"
echo ""
echo "  Save this key — it will not be shown again."
echo "=========================================="

# Write .env.assistant
ENV_FILE="${SCRIPT_DIR}/.env.assistant"
cat > "$ENV_FILE" <<EOF
# Arkeon Knowledge Graph - Assistant Agent (${AGENT_NAME})
# Generated $(date -u +"%Y-%m-%dT%H:%M:%SZ")
ARKE_API_URL=${API_URL}
ARKE_API_KEY=${ASSISTANT_KEY}
ARKE_SPACE_ID=${SPACE_ID}
EOF
echo ""
echo "Saved to: ${ENV_FILE}"
echo ""
echo "Next: fill in the values in integration/claude-code-snippet.md"
echo "and give it to your AI assistant."
