#!/usr/bin/env bash
# Stress test for knowledge graph dedup + cross-document connectivity.
#
# Three waves:
#   Wave 1: 4 cables uploaded in parallel (tests parallel extraction + post-merge)
#   Wave 2: 3 cables uploaded in parallel with entities overlapping wave 1 (tests scout context)
#   Wave 3: 3 cables uploaded sequentially (tests iterative graph growth)
#
# Expects: arkeon running on $BASE with --knowledge, LLM configured, scope_to_space=true
#
# Usage: BASE=http://localhost:8001 ADMIN_KEY=ak_... ./scripts/test-dedup-stress.sh

set -euo pipefail

BASE="${BASE:-http://localhost:8001}"
AK="${ADMIN_KEY:-}"

if [ -z "$AK" ]; then
  echo "Error: ADMIN_KEY not set"
  exit 1
fi

# --- Helpers ---
json_post() {
  curl -sf -X POST -H "Content-Type: application/json" -H "Authorization: ApiKey $AK" "$BASE$1" -d "$2"
}
text_post() {
  curl -sf -X POST -H "Content-Type: text/plain" -H "Authorization: ApiKey $AK" "$BASE/entities/$1/content?key=body&ver=1" -d "$2"
}
search_space() {
  curl -sf -H "Authorization: ApiKey $AK" "$BASE/search?q=$1&space_id=$SPACE_ID&limit=20"
}
wait_entity_extraction() {
  local entity_id=$1
  local timeout=${2:-180}
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    local status
    status=$(curl -sf -H "Authorization: ApiKey $AK" "$BASE/knowledge/jobs?entity_id=$entity_id&limit=5" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for j in d.get('jobs',[]):
  if j['job_type']=='ingest' and not j.get('parent_job_id'):
    print(j['status'])
    break
" 2>/dev/null || echo "none")
    if [ "$status" = "completed" ] || [ "$status" = "failed" ]; then
      echo "$status"
      return
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done
  echo "timeout"
}
upload_cable() {
  local label=$1
  local text=$2
  local eid
  eid=$(json_post /entities "{\"type\":\"document\",\"properties\":{\"label\":\"$label\"},\"space_id\":\"$SPACE_ID\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['entity']['id'])")
  text_post "$eid" "$text" > /dev/null
  echo "$eid"
}
count_entity() {
  local query=$1
  search_space "$query" | python3 -c "
import sys,json
d=json.load(sys.stdin)
hits = [r for r in d.get('results',[]) if r.get('type') != 'document' and r.get('type') != 'text_chunk']
print(len(hits))" 2>/dev/null
}
entity_relationships() {
  local eid=$1
  curl -sf -H "Authorization: ApiKey $AK" "$BASE/entities/$eid?view=expanded" | python3 -c "
import sys,json
d=json.load(sys.stdin)
rels = d.get('entity',{}).get('_relationships',[])
sources = set()
for r in rels:
  src = r.get('properties',{}).get('source_document_id','')
  if src: sources.add(src[-6:])
label = d['entity']['properties'].get('label','?')
print(f'{label}: {len(rels)} rels from {len(sources)} doc(s)')" 2>/dev/null
}

# --- Create space ---
echo "=== Setup ==="
SPACE_ID=$(json_post /spaces '{"name":"dedup-stress-test"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['space']['id'])")
echo "Space: $SPACE_ID"
echo ""

# ============================================================
# WAVE 1: 4 cables in parallel (shared entities: Kissinger, CIA, OPEC, Shah, Soviet Union)
# ============================================================
echo "=== Wave 1: 4 cables in PARALLEL ==="
echo "  Testing: parallel extraction + post-merge dedupe"

E1=$(upload_cable "TEHRAN-04821 Kissinger-Shah Meeting" \
"CONFIDENTIAL - CABLE 1974-TEHRAN-04821
Secretary of State Henry Kissinger met with Shah Mohammad Reza Pahlavi in Tehran on November 2, 1974. Ambassador Richard Helms facilitated the meeting at the Niavaran Palace. Kissinger expressed concern about OPEC price increases and their impact on Western economies. The Shah assured Iran would moderate its position at the upcoming OPEC summit in Vienna. The Central Intelligence Agency station chief briefed Kissinger on Soviet military advisors in Iraq. The Defense Intelligence Agency provided satellite imagery of Soviet T-62 tanks at Al-Walid airbase. Kissinger authorized support for Kurdish resistance forces through the SAVAK liaison.")

E2=$(upload_cable "JIDDA-03190 Kissinger-Faisal Oil Talks" \
"SECRET - CABLE 1974-JIDDA-03190
Dr. Henry Kissinger arrived in Jeddah on November 5, 1974 for talks with King Faisal bin Abdulaziz Al Saud about the oil embargo aftermath and OPEC pricing strategy. The Secretary of State emphasized that high oil prices threatened the global economic order. King Faisal expressed willingness to use Saudi Arabia influence within OPEC to stabilize prices. Ambassador James Akins accompanied Kissinger to the Royal Palace. The Central Intelligence Agency reported Soviet diplomats courting Saudi officials. The National Security Council prepared background memoranda on Saudi-Soviet contacts. The Defense Intelligence Agency assessed Moscow overtures posed a strategic threat to U.S. interests in the Persian Gulf.")

E3=$(upload_cable "CAIRO-05521 Sadat Peace Initiative" \
"SECRET - CABLE 1974-CAIRO-05521
Ambassador Hermann Eilts reported that Egyptian President Anwar Sadat is growing impatient with the pace of negotiations and may seek direct talks with Israel. Sadat told Eilts that continued reliance on Secretary Kissinger shuttle diplomacy was unsustainable. The Central Intelligence Agency station in Cairo confirmed Sadat faces domestic pressure from hardliners in the Egyptian military. The Soviet Union has been increasing diplomatic pressure on Egypt to reject American mediation. The National Security Council convened to discuss implications for the broader Middle East peace process. Secretary Kissinger recommended accelerating the Sinai disengagement timeline.")

E4=$(upload_cable "DAMASCUS-02110 Assad-Gromyko Meeting" \
"TOP SECRET - CABLE 1974-DAMASCUS-02110
Syrian President Hafez al-Assad met with Soviet Foreign Minister Andrei Gromyko in Damascus to discuss military cooperation. The Central Intelligence Agency reported the Soviet Union agreed to increase arms shipments to Syria through the port of Latakia. Assad expressed frustration with Secretary Kissinger mediation efforts on the Golan Heights. The Defense Intelligence Agency tracked significant Soviet naval activity in the eastern Mediterranean. The National Security Council assessed that Moscow primary objective was to prevent a comprehensive peace settlement that would exclude Soviet influence from the region.")

echo "  Uploaded: $E1 $E2 $E3 $E4"
echo "  Waiting for all 4 to complete..."

for EID in $E1 $E2 $E3 $E4; do
  STATUS=$(wait_entity_extraction "$EID" 300)
  echo "    ...${EID:(-6)}: $STATUS"
done

echo ""
echo "  --- Wave 1 Results ---"
echo "  Kissinger entities: $(count_entity kissinger)"
echo "  CIA entities: $(count_entity 'central+intelligence+agency')"
echo "  OPEC entities: $(count_entity opec)"
echo "  Soviet Union entities: $(count_entity soviet)"
echo "  NSC entities: $(count_entity 'national+security+council')"
echo "  Shah entities: $(count_entity shah)"
echo "  Sadat entities: $(count_entity sadat)"
echo "  Assad entities: $(count_entity assad)"

# Find Kissinger entity and check cross-doc relationships
KISSINGER_ID=$(search_space "kissinger" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for r in d.get('results',[]):
  if r.get('type')=='person' and 'kissinger' in r.get('properties',{}).get('label','').lower():
    print(r['id']); break" 2>/dev/null)
if [ -n "$KISSINGER_ID" ]; then
  echo ""
  echo "  Kissinger connectivity:"
  echo "    $(entity_relationships "$KISSINGER_ID")"
fi
echo ""

# ============================================================
# WAVE 2: 3 cables in parallel (overlapping with wave 1 entities)
# ============================================================
echo "=== Wave 2: 3 cables in PARALLEL (overlap with wave 1) ==="
echo "  Testing: scout finds wave 1 entities + parallel merge"

E5=$(upload_cable "STATE-28451 Middle East Policy Review" \
"TOP SECRET - CABLE 1974-STATE-28451
Secretary of State Henry Kissinger completed his latest round of shuttle diplomacy between Israel, Egypt, and Syria. The National Security Council convened a special session to assess progress. The Central Intelligence Agency provided an updated National Intelligence Estimate. Egypt under President Anwar Sadat was committed to peace but faced pressure. Syria President Hafez al-Assad remained skeptical. Israel Prime Minister Yitzhak Rabin faced coalition instability. The Defense Intelligence Agency reported the Soviet Union increasing arms shipments to Syria. The Shah of Iran continued positioning himself as the regional policeman. King Faisal of Saudi Arabia insisted oil policy and the Arab-Israeli conflict were linked. OPEC gave Faisal enormous leverage. Kissinger recommended to President Gerald Ford to continue bilateral negotiations and deepen the security relationship with Shah of Iran.")

E6=$(upload_cable "MOSCOW-08834 Brezhnev Back-Channel" \
"TOP SECRET - CABLE 1974-MOSCOW-08834
Soviet General Secretary Leonid Brezhnev signaled to Secretary Kissinger through back-channel communications that Moscow would not obstruct a limited Sinai disengagement. The Central Intelligence Agency station in Moscow reported growing tension between the Soviet Foreign Ministry under Andrei Gromyko and Soviet military leadership over Middle East policy. The KGB was independently cultivating contacts with Palestinian factions. The National Security Council assessed the Soviet Union primary objective was preventing a comprehensive settlement excluding Moscow. Ambassador Walter Stoessel reported Brezhnev privately concerned about Chinese influence in the developing world.")

E7=$(upload_cable "TEHRAN-05102 Shah Arms Purchase" \
"SECRET - CABLE 1974-TEHRAN-05102
Shah Mohammad Reza Pahlavi presented Ambassador Richard Helms with a request for advanced F-14 Tomcat fighters and Phoenix missile systems. The Shah argued Iran needed modern air defenses against potential Soviet aggression from Iraq. The Defense Intelligence Agency confirmed increasing Soviet military presence along the Iran-Iraq border. Secretary Kissinger authorized preliminary discussions on the arms package. The Central Intelligence Agency assessed the Shah strategic importance as a counterweight to Soviet influence in the Persian Gulf. OPEC revenue gave Iran substantial purchasing power. The National Security Council will review the full arms transfer at the next principals meeting.")

echo "  Uploaded: $E5 $E6 $E7"
echo "  Waiting for all 3 to complete..."

for EID in $E5 $E6 $E7; do
  STATUS=$(wait_entity_extraction "$EID" 300)
  echo "    ...${EID:(-6)}: $STATUS"
done

echo ""
echo "  --- Wave 2 Results (cumulative) ---"
echo "  Kissinger entities: $(count_entity kissinger)"
echo "  CIA entities: $(count_entity 'central+intelligence+agency')"
echo "  OPEC entities: $(count_entity opec)"
echo "  Soviet Union entities: $(count_entity soviet)"
echo "  Shah entities: $(count_entity shah)"
echo "  Sadat entities: $(count_entity sadat)"
echo "  Assad entities: $(count_entity assad)"
echo "  Brezhnev entities: $(count_entity brezhnev)"
echo "  Gromyko entities: $(count_entity gromyko)"
echo "  Gerald Ford entities: $(count_entity ford)"

if [ -n "$KISSINGER_ID" ]; then
  echo ""
  echo "  Kissinger connectivity (should grow):"
  echo "    $(entity_relationships "$KISSINGER_ID")"
fi
echo ""

# ============================================================
# WAVE 3: 3 cables sequentially (iterative graph growth)
# ============================================================
echo "=== Wave 3: 3 cables SEQUENTIALLY ==="
echo "  Testing: iterative growth, each doc benefits from prior context"

E8=$(upload_cable "AMMAN-01887 King Hussein Back-Channel" \
"SECRET - CABLE 1974-AMMAN-01887
Jordan King Hussein maintained close but covert contacts with Israeli officials, facilitated by the Central Intelligence Agency station in Amman. These back-channel communications proved valuable during the October 1973 war. Secretary Kissinger personally managed the Hussein-Israel channel as part of his shuttle diplomacy strategy. The National Security Council assessed Jordan as a critical moderate voice. King Faisal of Saudi Arabia provided financial support to Jordan to maintain stability. The Soviet Union had limited influence in Amman compared to Damascus and Cairo. President Anwar Sadat privately encouraged Hussein direct dialogue with Israel.")
echo "  Cable 8 uploaded: $E8"
STATUS=$(wait_entity_extraction "$E8" 300)
echo "    Status: $STATUS"
echo "    Kissinger entities: $(count_entity kissinger) | Hussein entities: $(count_entity hussein)"

E9=$(upload_cable "TRIPOLI-00443 Gaddafi Threat Assessment" \
"SECRET - CABLE 1974-TRIPOLI-00443
Libya Colonel Muammar Gaddafi continued to fund radical Palestinian factions and channel arms to insurgent groups in sub-Saharan Africa. The Central Intelligence Agency assessed Gaddafi as the primary destabilizing force in North Africa. Secretary Kissinger briefed President Gerald Ford on the Libyan threat. The National Security Council recommended enhanced monitoring of Libyan activities. King Faisal of Saudi Arabia privately warned Kissinger about Gaddafi growing influence. The Soviet Union maintained arms sales to Libya despite concerns about Gaddafi unpredictability. The Defense Intelligence Agency tracked Libyan military buildup near the Egyptian border, alarming President Anwar Sadat.")
echo "  Cable 9 uploaded: $E9"
STATUS=$(wait_entity_extraction "$E9" 300)
echo "    Status: $STATUS"
echo "    Kissinger entities: $(count_entity kissinger) | Gaddafi entities: $(count_entity gaddafi)"

E10=$(upload_cable "STATE-30012 Year-End Intelligence Summary" \
"TOP SECRET - CABLE 1974-STATE-30012
Secretary of State Henry Kissinger presented the year-end intelligence summary to President Gerald Ford. Key findings: Shah Mohammad Reza Pahlavi remains the anchor of U.S. strategy in the Persian Gulf. King Faisal of Saudi Arabia holds decisive influence over OPEC pricing. President Anwar Sadat has committed to the peace process despite domestic opposition. Syrian President Hafez al-Assad will not agree to terms without Soviet backing. Soviet General Secretary Leonid Brezhnev seeks to maintain Moscow role in any settlement. Jordan King Hussein is the most reliable American partner in the Arab world. Libya Colonel Muammar Gaddafi poses an increasing threat to regional stability. The Central Intelligence Agency, Defense Intelligence Agency, and National Security Council contributed assessments. Israel Prime Minister Yitzhak Rabin faces growing domestic political challenges.")
echo "  Cable 10 uploaded: $E10"
STATUS=$(wait_entity_extraction "$E10" 300)
echo "    Status: $STATUS"

echo ""
echo "=== FINAL RESULTS ==="
echo ""
echo "Entity counts (should be 1 each for key actors):"
echo "  Kissinger:    $(count_entity kissinger)"
echo "  Shah/Pahlavi: $(count_entity shah)"
echo "  King Faisal:  $(count_entity faisal)"
echo "  Sadat:        $(count_entity sadat)"
echo "  Assad:        $(count_entity assad)"
echo "  Brezhnev:     $(count_entity brezhnev)"
echo "  Gromyko:      $(count_entity gromyko)"
echo "  Gerald Ford:  $(count_entity ford)"
echo "  King Hussein: $(count_entity hussein)"
echo "  Gaddafi:      $(count_entity gaddafi)"
echo "  Rabin:        $(count_entity rabin)"
echo ""
echo "Organization counts (should be 1 each):"
echo "  CIA:          $(count_entity 'central+intelligence+agency')"
echo "  DIA:          $(count_entity 'defense+intelligence+agency')"
echo "  NSC:          $(count_entity 'national+security+council')"
echo "  OPEC:         $(count_entity opec)"
echo "  Soviet Union: $(count_entity soviet)"
echo ""

if [ -n "$KISSINGER_ID" ]; then
  echo "Kissinger connectivity:"
  echo "  $(entity_relationships "$KISSINGER_ID")"
fi

# Check a few more key entities
for NAME in sadat assad "king+faisal" shah; do
  EID=$(search_space "$NAME" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for r in d.get('results',[]):
  if r.get('type')=='person':
    print(r['id']); break" 2>/dev/null)
  if [ -n "$EID" ]; then
    echo "  $(entity_relationships "$EID")"
  fi
done

echo ""
echo "Total entities in space:"
curl -sf -H "Authorization: ApiKey $AK" "$BASE/search?q=1974&space_id=$SPACE_ID&limit=100" | python3 -c "
import sys,json
d=json.load(sys.stdin)
results = d.get('results',[])
types = {}
for r in results:
  t = r.get('type','?')
  types[t] = types.get(t,0) + 1
print(f'  Total: {len(results)}')
for t,c in sorted(types.items(), key=lambda x:-x[1]):
  print(f'  {t}: {c}')
"
echo ""
echo "Done."
