#!/usr/bin/env bash
#
# E2E test for the PDF extraction pipeline.
# Creates an entity, uploads a PDF, triggers ingest, polls job status.
#
set -euo pipefail

API="http://localhost:8002"
API_KEY="ak_test_pdf_admin"
PDF_FILE="${1:-/Users/chim/Working/arkeon/arkeon/scripts/pdf-classify-test/pdfs/US_Constitution__digital_.pdf}"

echo "=== PDF Pipeline E2E Test ==="
echo "API: $API"
echo "PDF: $PDF_FILE"
echo ""

# 1. Create an arke (knowledge base)
echo "--- Step 1: Create arke ---"
ARKE_RESP=$(curl -s -X POST "$API/arkes" \
  -H "Authorization: ApiKey $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"pdf-test","description":"Test arke for PDF pipeline"}')
ARKE_ID=$(echo "$ARKE_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")
if [ -z "$ARKE_ID" ]; then
  echo "  Failed to create arke: $ARKE_RESP"
  # Try to get existing
  ARKE_ID=$(curl -s "$API/arkes" -H "Authorization: ApiKey $API_KEY" | python3 -c "import sys,json; arkes=json.load(sys.stdin).get('arkes',[]); print(arkes[0]['id'] if arkes else '')" 2>/dev/null || echo "")
  if [ -z "$ARKE_ID" ]; then
    echo "  No arkes found, aborting"
    exit 1
  fi
fi
echo "  Arke ID: $ARKE_ID"

# 2. Create a document entity
echo ""
echo "--- Step 2: Create entity ---"
ENTITY_RESP=$(curl -s -X POST "$API/entities" \
  -H "Authorization: ApiKey $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"document\",\"arke_id\":\"$ARKE_ID\",\"properties\":{\"label\":\"US Constitution PDF Test\"}}")
ENTITY_ID=$(echo "$ENTITY_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id','') or d.get('entity',{}).get('id',''))" 2>/dev/null || echo "")
if [ -z "$ENTITY_ID" ]; then
  echo "  Failed to create entity: $ENTITY_RESP"
  exit 1
fi
echo "  Entity ID: $ENTITY_ID"

# 3. Upload PDF as content
echo ""
echo "--- Step 3: Upload PDF content ---"
UPLOAD_RESP=$(curl -s -X POST "$API/entities/$ENTITY_ID/content?key=original&ver=1" \
  -H "Authorization: ApiKey $API_KEY" \
  -H "Content-Type: application/pdf" \
  --data-binary @"$PDF_FILE")
echo "  Upload response: $UPLOAD_RESP"

# 4. Trigger ingest
echo ""
echo "--- Step 4: Trigger ingest ---"
INGEST_RESP=$(curl -s -X POST "$API/knowledge/ingest" \
  -H "Authorization: ApiKey $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"entity_ids\":[\"$ENTITY_ID\"]}")
JOB_ID=$(echo "$INGEST_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); jobs=d.get('jobs',[]); print(jobs[0]['job_id'] if jobs else '')" 2>/dev/null || echo "")
echo "  Ingest response: $INGEST_RESP"
echo "  Job ID: $JOB_ID"

if [ -z "$JOB_ID" ]; then
  echo "  No job ID returned, aborting"
  exit 1
fi

# 5. Poll job status
echo ""
echo "--- Step 5: Polling job status ---"
MAX_POLLS=120
POLL_INTERVAL=3

for i in $(seq 1 $MAX_POLLS); do
  JOB_RESP=$(curl -s "$API/knowledge/jobs/$JOB_ID" \
    -H "Authorization: ApiKey $API_KEY")
  STATUS=$(echo "$JOB_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','unknown'))" 2>/dev/null || echo "unknown")

  if [ "$STATUS" = "completed" ]; then
    echo "  [$(( i * POLL_INTERVAL ))s] Job COMPLETED"
    echo ""
    echo "--- Result ---"
    echo "$JOB_RESP" | python3 -m json.tool 2>/dev/null || echo "$JOB_RESP"
    break
  elif [ "$STATUS" = "failed" ]; then
    echo "  [$(( i * POLL_INTERVAL ))s] Job FAILED"
    echo ""
    echo "--- Error ---"
    echo "$JOB_RESP" | python3 -m json.tool 2>/dev/null || echo "$JOB_RESP"

    # Also check child jobs
    echo ""
    echo "--- Child Jobs ---"
    CHILDREN=$(curl -s "$API/knowledge/jobs?parent_job_id=$JOB_ID" \
      -H "Authorization: ApiKey $API_KEY")
    echo "$CHILDREN" | python3 -m json.tool 2>/dev/null || echo "$CHILDREN"
    exit 1
  elif [ "$STATUS" = "waiting" ]; then
    # Check child jobs progress
    CHILDREN_SUMMARY=$(curl -s "$API/knowledge/jobs?parent_job_id=$JOB_ID" \
      -H "Authorization: ApiKey $API_KEY" | python3 -c "
import sys, json
try:
    jobs = json.load(sys.stdin).get('jobs', [])
    statuses = {}
    for j in jobs:
        s = j.get('status', 'unknown')
        statuses[s] = statuses.get(s, 0) + 1
    # Also check grandchildren
    print(f'{len(jobs)} children: {statuses}')
except: print('?')
" 2>/dev/null || echo "?")
    echo "  [$(( i * POLL_INTERVAL ))s] $STATUS ($CHILDREN_SUMMARY)"
  else
    echo "  [$(( i * POLL_INTERVAL ))s] $STATUS"
  fi

  sleep $POLL_INTERVAL
done

# 6. Check job logs
echo ""
echo "--- Job Logs ---"
LOGS=$(curl -s "$API/knowledge/jobs/$JOB_ID/logs" \
  -H "Authorization: ApiKey $API_KEY")
echo "$LOGS" | python3 -c "
import sys, json
try:
    logs = json.load(sys.stdin).get('logs', [])
    for log in logs[-20:]:
        ts = log.get('created_at','')[-12:-1] if log.get('created_at') else ''
        level = log.get('level','')
        msg = log.get('message','')
        print(f'  [{ts}] {level}: {msg}')
except Exception as e:
    print(f'  Error: {e}')
    print(sys.stdin.read() if hasattr(sys.stdin, 'read') else '')
" 2>/dev/null || echo "$LOGS"

# 7. List all jobs in hierarchy
echo ""
echo "--- All Jobs ---"
ALL_JOBS=$(curl -s "$API/knowledge/jobs?entity_id=$ENTITY_ID" \
  -H "Authorization: ApiKey $API_KEY")
echo "$ALL_JOBS" | python3 -c "
import sys, json
try:
    jobs = json.load(sys.stdin).get('jobs', [])
    for j in jobs:
        jtype = j.get('job_type','?')
        status = j.get('status','?')
        jid = j.get('id','?')[:12]
        tokens = j.get('tokens_in',0) or 0
        model = j.get('model','') or ''
        result = j.get('result', {}) or {}
        entities = result.get('createdEntities', result.get('plan', {}).get('entities', '?') if isinstance(result.get('plan'), dict) else '?')
        print(f'  {jid}.. {jtype:20s} {status:12s} tokens_in={tokens:>6d}  model={model}  entities={entities}')
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null || echo "$ALL_JOBS"

echo ""
echo "=== Done ==="
