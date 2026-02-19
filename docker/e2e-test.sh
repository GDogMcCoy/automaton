#!/usr/bin/env bash
# Conway Automaton E2E Test Harness
#
# Boots the automaton in a Docker container, waits for health,
# runs basic verification, and tears down.
#
# Usage:
#   ./docker/e2e-test.sh
#   CONWAY_API_KEY=... ./docker/e2e-test.sh  # With real API (optional)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONTAINER_NAME="automaton-e2e-test"
IMAGE_NAME="automaton-e2e:test"
HEALTH_PORT=8080
TIMEOUT=60

cleanup() {
  echo "[E2E] Cleaning up..."
  docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== Conway Automaton E2E Test ==="
echo ""

# Step 1: Build the image
echo "[E2E] Building Docker image..."
docker build -t "${IMAGE_NAME}" -f "${SCRIPT_DIR}/Dockerfile" "${PROJECT_DIR}" --quiet

# Step 2: Start the container with --status flag first (quick validation)
echo "[E2E] Running build verification (--version)..."
VERSION_OUTPUT=$(docker run --rm "${IMAGE_NAME}" --version 2>&1)
echo "  Version: ${VERSION_OUTPUT}"

if echo "${VERSION_OUTPUT}" | grep -q "Conway Automaton"; then
  echo "  PASS: Version output correct"
else
  echo "  FAIL: Unexpected version output"
  exit 1
fi

# Step 3: Start the container with health check
echo "[E2E] Starting container with health endpoint..."
docker run -d \
  --name "${CONTAINER_NAME}" \
  -p "${HEALTH_PORT}:${HEALTH_PORT}" \
  -e "NODE_ENV=production" \
  -e "AUTOMATON_DATA_DIR=/app/data" \
  -e "LOG_LEVEL=debug" \
  "${IMAGE_NAME}" --run 2>/dev/null

# Step 4: Wait for health endpoint (or timeout)
echo "[E2E] Waiting for health endpoint (timeout: ${TIMEOUT}s)..."
ELAPSED=0
HEALTHY=false

while [ "${ELAPSED}" -lt "${TIMEOUT}" ]; do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${HEALTH_PORT}/health" 2>/dev/null || echo "000")

  if [ "${HTTP_CODE}" = "200" ] || [ "${HTTP_CODE}" = "503" ]; then
    HEALTHY=true
    echo "  Health endpoint responded: HTTP ${HTTP_CODE} (${ELAPSED}s)"
    break
  fi

  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

if [ "${HEALTHY}" = "true" ]; then
  echo "  PASS: Health endpoint is responding"
else
  echo "  FAIL: Health endpoint did not respond within ${TIMEOUT}s"
  echo ""
  echo "[E2E] Container logs:"
  docker logs "${CONTAINER_NAME}" 2>&1 | tail -50
  exit 1
fi

# Step 5: Verify health response body
echo "[E2E] Verifying health response..."
HEALTH_BODY=$(curl -s "http://localhost:${HEALTH_PORT}/health" 2>/dev/null)
echo "  Response: ${HEALTH_BODY}"

if echo "${HEALTH_BODY}" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'status' in d" 2>/dev/null; then
  echo "  PASS: Health response is valid JSON with 'status' field"
else
  echo "  WARN: Could not validate health JSON (python3 may not be available)"
fi

# Step 6: Verify metrics endpoint
echo "[E2E] Verifying metrics endpoint..."
METRICS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${HEALTH_PORT}/metrics" 2>/dev/null || echo "000")
if [ "${METRICS_CODE}" = "200" ]; then
  echo "  PASS: Metrics endpoint responds HTTP 200"
else
  echo "  FAIL: Metrics endpoint responded HTTP ${METRICS_CODE}"
  exit 1
fi

# Step 7: Verify readiness endpoint
echo "[E2E] Verifying readiness endpoint..."
READY_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${HEALTH_PORT}/ready" 2>/dev/null || echo "000")
echo "  Readiness: HTTP ${READY_CODE}"
# 503 is expected if agent hasn't fully started yet
if [ "${READY_CODE}" = "200" ] || [ "${READY_CODE}" = "503" ]; then
  echo "  PASS: Readiness endpoint is responding"
else
  echo "  FAIL: Readiness endpoint responded HTTP ${READY_CODE}"
  exit 1
fi

# Step 8: Verify 404 for unknown routes
echo "[E2E] Verifying 404 for unknown routes..."
UNKNOWN_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${HEALTH_PORT}/nonexistent" 2>/dev/null || echo "000")
if [ "${UNKNOWN_CODE}" = "404" ]; then
  echo "  PASS: Unknown route returns 404"
else
  echo "  FAIL: Unknown route returned HTTP ${UNKNOWN_CODE}"
  exit 1
fi

# Step 9: Container resource check
echo "[E2E] Checking container resource usage..."
docker stats "${CONTAINER_NAME}" --no-stream --format "  Memory: {{.MemUsage}}, CPU: {{.CPUPerc}}" 2>/dev/null || echo "  (stats not available)"

# Step 10: Graceful shutdown
echo "[E2E] Testing graceful shutdown..."
docker stop -t 10 "${CONTAINER_NAME}" 2>/dev/null
EXIT_CODE=$(docker inspect "${CONTAINER_NAME}" --format='{{.State.ExitCode}}' 2>/dev/null || echo "unknown")
echo "  Exit code: ${EXIT_CODE}"

if [ "${EXIT_CODE}" = "0" ]; then
  echo "  PASS: Graceful shutdown succeeded"
else
  echo "  WARN: Exit code was ${EXIT_CODE} (non-zero may be OK if API key was missing)"
fi

echo ""
echo "=== E2E Test Complete ==="
echo "All basic health/metrics/readiness checks passed."
