#!/usr/bin/env bash
# Live-seed script for testing Map mode.
# Creates entities and relationships with delays so you can watch the graph grow.

set -euo pipefail

KEY="${1:-ak_0e9a76fc0ba6f610e53210c04a46454074175cd0f85f0686a0c6ce942b7e7095}"
BASE="http://localhost:8000"
DELAY="${2:-2}" # seconds between operations

create_entity() {
  local type="$1" label="$2" desc="$3" space="$4"
  local body="{\"type\":\"$type\",\"properties\":{\"label\":\"$label\",\"description\":\"$desc\"}"
  if [ -n "$space" ]; then
    body="$body,\"space_id\":\"$space\""
  fi
  body="$body}"

  local resp
  resp=$(curl -s -X POST "$BASE/entities" -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d "$body")
  local id
  id=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin)['entity']['id'])")
  echo "$id"
}

create_rel() {
  local src="$1" tgt="$2" pred="$3"
  curl -s -X POST "$BASE/relationships" -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
    -d "{\"source_id\":\"$src\",\"target_id\":\"$tgt\",\"predicate\":\"$pred\",\"properties\":{}}" > /dev/null
}

echo "=== Live Seeding ==="
echo "Delay between ops: ${DELAY}s"
echo ""

# Get existing spaces
SPACES=$(curl -s "$BASE/spaces" -H "X-API-Key: $KEY")
SPACE1=$(echo "$SPACES" | python3 -c "import sys,json; d=json.load(sys.stdin)['spaces']; print(d[0]['id'] if d else '')")
SPACE2=$(echo "$SPACES" | python3 -c "import sys,json; d=json.load(sys.stdin)['spaces']; print(d[1]['id'] if len(d)>1 else '')")

if [ -z "$SPACE1" ]; then
  echo "Creating Space 1 (Ancient Texts)..."
  SPACE1=$(curl -s -X POST "$BASE/spaces" -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
    -d '{"name":"ancient-texts","description":"Ancient theological and philosophical texts"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['space']['id'])")
fi
if [ -z "$SPACE2" ]; then
  echo "Creating Space 2 (Modern Analysis)..."
  SPACE2=$(curl -s -X POST "$BASE/spaces" -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
    -d '{"name":"modern-analysis","description":"Modern scholarly analysis"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['space']['id'])")
fi

echo "Space 1: $SPACE1"
echo "Space 2: $SPACE2"
echo ""

# Wave 1: Ancient texts cluster
echo "--- Wave 1: Ancient texts ---"

echo "[+] Creating: Genesis (document)"
E1=$(create_entity "document" "Genesis" "The first book of the Hebrew Bible" "$SPACE1")
echo "    $E1"
sleep "$DELAY"

echo "[+] Creating: Exodus (document)"
E2=$(create_entity "document" "Exodus" "The second book of the Torah" "$SPACE1")
echo "    $E2"
sleep "$DELAY"

echo "[~] Linking: Genesis -> relates_to -> Exodus"
create_rel "$E1" "$E2" "relates_to"
sleep "$DELAY"

echo "[+] Creating: Moses (person)"
E3=$(create_entity "person" "Moses" "Prophet and lawgiver in Abrahamic religions" "$SPACE1")
echo "    $E3"
sleep "$DELAY"

echo "[~] Linking: Moses -> created_by -> Exodus"
create_rel "$E3" "$E2" "created_by"
sleep "$DELAY"

echo "[+] Creating: Covenant (concept)"
E4=$(create_entity "concept" "Covenant" "Sacred agreement between God and humanity" "$SPACE1")
echo "    $E4"
sleep "$DELAY"

echo "[~] Linking: Covenant -> referenced_in -> Genesis"
create_rel "$E4" "$E1" "references"
echo "[~] Linking: Covenant -> referenced_in -> Exodus"
create_rel "$E4" "$E2" "references"
sleep "$DELAY"

echo "[+] Creating: Abraham (person)"
E5=$(create_entity "person" "Abraham" "Patriarch of the Abrahamic religions" "$SPACE1")
echo "    $E5"
sleep "$DELAY"

echo "[~] Linking: Abraham -> relates_to -> Covenant"
create_rel "$E5" "$E4" "relates_to"
echo "[~] Linking: Abraham -> references -> Genesis"
create_rel "$E5" "$E1" "references"
sleep "$DELAY"

# Wave 2: Modern analysis cluster
echo ""
echo "--- Wave 2: Modern analysis ---"

echo "[+] Creating: Wellhausen (person)"
E6=$(create_entity "person" "Julius Wellhausen" "German biblical scholar, Documentary Hypothesis" "$SPACE2")
echo "    $E6"
sleep "$DELAY"

echo "[+] Creating: Documentary Hypothesis (concept)"
E7=$(create_entity "concept" "Documentary Hypothesis" "Theory of four source documents behind the Torah" "$SPACE2")
echo "    $E7"
sleep "$DELAY"

echo "[~] Linking: Wellhausen -> created_by -> Documentary Hypothesis"
create_rel "$E6" "$E7" "created_by"
sleep "$DELAY"

echo "[+] Creating: Source Criticism (concept)"
E8=$(create_entity "concept" "Source Criticism" "Method of analyzing texts by identifying original sources" "$SPACE2")
echo "    $E8"
sleep "$DELAY"

echo "[~] Linking: Source Criticism -> enables -> Documentary Hypothesis"
create_rel "$E8" "$E7" "enables"
sleep "$DELAY"

echo "[+] Creating: Priestly Source (document)"
E9=$(create_entity "document" "Priestly Source" "One of four hypothesized Torah sources (P)" "$SPACE2")
echo "    $E9"
sleep "$DELAY"

echo "[~] Linking: Priestly Source -> relates_to -> Documentary Hypothesis"
create_rel "$E9" "$E7" "relates_to"
sleep "$DELAY"

# Wave 3: Cross-space connections (the demo payoff!)
echo ""
echo "--- Wave 3: CROSS-SPACE connections ---"
echo "    (watch for the dashed amber edges!)"
sleep "$DELAY"

echo "[*] Cross-link: Documentary Hypothesis -> references -> Genesis"
create_rel "$E7" "$E1" "references"
sleep "$DELAY"

echo "[*] Cross-link: Wellhausen -> references -> Exodus"
create_rel "$E6" "$E2" "references"
sleep "$DELAY"

echo "[*] Cross-link: Source Criticism -> influenced -> Covenant"
create_rel "$E8" "$E4" "influenced"
sleep "$DELAY"

echo "[*] Cross-link: Priestly Source -> references -> Genesis"
create_rel "$E9" "$E1" "references"
sleep "$DELAY"

echo ""
echo "=== Done! ==="
echo "Added 9 entities and ~14 relationships across 2 spaces."
echo "Cross-space edges should be visible as dashed amber lines."
