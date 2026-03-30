#!/bin/bash
# Run the same checks as CI locally before pushing.
# Usage: ./scripts/test-local.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

step() { echo -e "\n${BOLD}=== $1 ===${NC}"; }
pass() { echo -e "${GREEN}PASS${NC}: $1"; }
fail() { echo -e "${RED}FAIL${NC}: $1"; exit 1; }

# Typecheck
step "Typecheck: API"
npm run typecheck -w packages/api || fail "API typecheck"
pass "API typecheck"

step "Typecheck: Control Plane"
npm run typecheck -w apps/control-plane || fail "Control plane typecheck"
pass "Control plane typecheck"

# User-data validation
step "Validate user-data script"
npx tsx apps/control-plane/scripts/test-userdata.ts || fail "User-data validation"
pass "User-data script"

# Docker build
step "Building Docker image"
docker build -t arke:ci . || fail "Docker build"
pass "Docker build"

# Start stack
step "Starting test stack"
docker compose -f docker-compose.ci.yml down -v 2>/dev/null || true
docker compose -f docker-compose.ci.yml up -d || fail "Docker compose up"

# Wait for health
step "Waiting for API health"
for i in $(seq 1 30); do
  if curl -sf http://localhost:8000/health > /dev/null 2>&1; then
    pass "API is healthy"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "Logs:"
    docker compose -f docker-compose.ci.yml logs
    fail "API did not start within 60s"
  fi
  sleep 2
done

# E2E tests
step "Running e2e tests"
E2E_BASE_URL=http://localhost:8000 \
ADMIN_BOOTSTRAP_KEY=ak_test_ci_key \
npm run test:e2e -w packages/api || {
  docker compose -f docker-compose.ci.yml logs
  docker compose -f docker-compose.ci.yml down -v
  fail "E2E tests"
}
pass "E2E tests"

# Cleanup
step "Cleanup"
docker compose -f docker-compose.ci.yml down -v
pass "Cleanup"

echo -e "\n${GREEN}${BOLD}All checks passed.${NC} Safe to push."
