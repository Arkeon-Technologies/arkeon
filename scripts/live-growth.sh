#!/usr/bin/env bash
# Live growth demo — creates a new space with entities arriving every few seconds.
# Run this while watching the Map view to see the graph grow in real time.
#
# Usage: ./scripts/live-growth.sh [api_key] [delay_seconds]

set -euo pipefail

KEY="${1:-ak_880d977c64f910a83a201367cd0c9ef5fd83a1bc3cac7418399e8c000084c344}"
BASE="http://localhost:8265"
DELAY="${2:-3}"

create_entity() {
  local type="$1" label="$2" desc="$3" space="$4"
  local body="{\"type\":\"$type\",\"properties\":{\"label\":\"$label\",\"description\":\"$desc\"},\"space_id\":\"$space\"}"
  local id
  id=$(curl -s -X POST "$BASE/entities" -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d "$body" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['entity']['id'])")
  echo "$id"
}

create_rel() {
  curl -s -X POST "$BASE/entities/$1/relationships" -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
    -d "{\"target_id\":\"$2\",\"predicate\":\"$3\",\"properties\":{}}" > /dev/null 2>&1
}

echo ""
echo "========================================="
echo "  LIVE GROWTH DEMO"
echo "  Delay: ${DELAY}s between operations"
echo "========================================="
echo ""
echo "Creating a new space: 'renaissance'..."
SPACE=$(curl -s -X POST "$BASE/spaces" -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"name":"renaissance-demo","description":"Renaissance art, science, and philosophy"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['space']['id'])")
echo "Space: $SPACE"
echo ""
echo "Watch the map at: http://localhost:8265/explore"
echo ""
sleep "$DELAY"

# Wave 1: Core figures
echo "--- Wave 1: Core Renaissance figures ---"
echo ""

echo "  [+] Leonardo da Vinci (person)"
E_LEO=$(create_entity "person" "Leonardo da Vinci" "Italian polymath: painter, sculptor, architect, scientist, inventor (1452-1519)" "$SPACE")
sleep "$DELAY"

echo "  [+] Michelangelo (person)"
E_MIC=$(create_entity "person" "Michelangelo" "Italian sculptor, painter, architect, poet of the High Renaissance (1475-1564)" "$SPACE")
sleep "$DELAY"

echo "  [~] Leonardo -> collaborated with -> Michelangelo"
create_rel "$E_LEO" "$E_MIC" "collaborated_with"
sleep "$DELAY"

echo "  [+] Mona Lisa (work)"
E_MONA=$(create_entity "work" "Mona Lisa" "Half-length portrait painting by Leonardo da Vinci, most famous painting in the world" "$SPACE")
sleep "$DELAY"

echo "  [~] Leonardo -> created -> Mona Lisa"
create_rel "$E_LEO" "$E_MONA" "created"
sleep "$DELAY"

echo "  [+] Sistine Chapel Ceiling (work)"
E_SIST=$(create_entity "work" "Sistine Chapel Ceiling" "Ceiling of the Sistine Chapel painted by Michelangelo (1508-1512)" "$SPACE")
sleep "$DELAY"

echo "  [~] Michelangelo -> created -> Sistine Chapel Ceiling"
create_rel "$E_MIC" "$E_SIST" "created"
sleep "$DELAY"

# Wave 2: Ideas and places
echo ""
echo "--- Wave 2: Ideas and places ---"
echo ""

echo "  [+] Humanism (concept)"
E_HUM=$(create_entity "concept" "Humanism" "Renaissance intellectual movement emphasizing human potential and classical learning" "$SPACE")
sleep "$DELAY"

echo "  [~] Leonardo -> influenced by -> Humanism"
create_rel "$E_LEO" "$E_HUM" "influenced_by"
echo "  [~] Michelangelo -> influenced by -> Humanism"
create_rel "$E_MIC" "$E_HUM" "influenced_by"
sleep "$DELAY"

echo "  [+] Florence (place)"
E_FLO=$(create_entity "place" "Florence" "Birthplace of the Renaissance, center of art, banking, and political thought" "$SPACE")
sleep "$DELAY"

echo "  [~] Leonardo -> based in -> Florence"
create_rel "$E_LEO" "$E_FLO" "based_in"
echo "  [~] Michelangelo -> based in -> Florence"
create_rel "$E_MIC" "$E_FLO" "based_in"
sleep "$DELAY"

echo "  [+] Medici Family (organization)"
E_MED=$(create_entity "organization" "Medici Family" "Powerful banking family and political dynasty that sponsored Renaissance art" "$SPACE")
sleep "$DELAY"

echo "  [~] Medici -> patronized -> Leonardo"
create_rel "$E_MED" "$E_LEO" "patronized"
echo "  [~] Medici -> patronized -> Michelangelo"
create_rel "$E_MED" "$E_MIC" "patronized"
echo "  [~] Medici -> based in -> Florence"
create_rel "$E_MED" "$E_FLO" "based_in"
sleep "$DELAY"

# Wave 3: More figures expanding the network
echo ""
echo "--- Wave 3: Expanding the network ---"
echo ""

echo "  [+] Raphael (person)"
E_RAP=$(create_entity "person" "Raphael" "Italian painter and architect of the High Renaissance (1483-1520)" "$SPACE")
sleep "$DELAY"

echo "  [~] Raphael -> influenced by -> Leonardo"
create_rel "$E_RAP" "$E_LEO" "influenced_by"
echo "  [~] Raphael -> rivaled -> Michelangelo"
create_rel "$E_RAP" "$E_MIC" "rivaled"
echo "  [~] Medici -> patronized -> Raphael"
create_rel "$E_MED" "$E_RAP" "patronized"
sleep "$DELAY"

echo "  [+] The School of Athens (work)"
E_SCHOOL=$(create_entity "work" "The School of Athens" "Fresco by Raphael depicting classical Greek philosophers (1509-1511)" "$SPACE")
sleep "$DELAY"

echo "  [~] Raphael -> created -> The School of Athens"
create_rel "$E_RAP" "$E_SCHOOL" "created"
sleep "$DELAY"

echo "  [+] Galileo Galilei (person)"
E_GAL=$(create_entity "person" "Galileo Galilei" "Italian astronomer and physicist, father of modern science (1564-1642)" "$SPACE")
sleep "$DELAY"

echo "  [~] Galileo -> influenced by -> Leonardo"
create_rel "$E_GAL" "$E_LEO" "influenced_by"
echo "  [~] Galileo -> based in -> Florence"
create_rel "$E_GAL" "$E_FLO" "based_in"
echo "  [~] Medici -> patronized -> Galileo"
create_rel "$E_MED" "$E_GAL" "patronized"
sleep "$DELAY"

echo "  [+] Heliocentrism (theory)"
E_HELIO=$(create_entity "theory" "Heliocentrism" "Astronomical model with the Sun at the center of the solar system" "$SPACE")
sleep "$DELAY"

echo "  [~] Galileo -> championed -> Heliocentrism"
create_rel "$E_GAL" "$E_HELIO" "championed"
sleep "$DELAY"

echo "  [+] Niccolò Machiavelli (person)"
E_MACH=$(create_entity "person" "Niccolo Machiavelli" "Italian diplomat and political philosopher, author of The Prince (1469-1527)" "$SPACE")
sleep "$DELAY"

echo "  [~] Machiavelli -> based in -> Florence"
create_rel "$E_MACH" "$E_FLO" "based_in"
echo "  [~] Machiavelli -> influenced by -> Humanism"
create_rel "$E_MACH" "$E_HUM" "influenced_by"
sleep "$DELAY"

echo "  [+] The Prince (work)"
E_PRINCE=$(create_entity "work" "The Prince" "Political treatise by Machiavelli on acquiring and maintaining political power" "$SPACE")
sleep "$DELAY"

echo "  [~] Machiavelli -> authored -> The Prince"
create_rel "$E_MACH" "$E_PRINCE" "authored"
sleep "$DELAY"

echo ""
echo "========================================="
echo "  DONE!"
echo "  Created 14 entities + ~20 relationships"
echo "  All in the 'renaissance' space"
echo "========================================="
