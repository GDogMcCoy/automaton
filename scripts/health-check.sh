#!/usr/bin/env bash
# Conway Automaton Health Check
# Returns JSON status for monitoring

set -euo pipefail

AUTOMATON_DIR="${HOME}/.automaton"
DB_PATH="${AUTOMATON_DIR}/state.db"
WALLET_PATH="${AUTOMATON_DIR}/wallet.json"

check_file() {
  if [ -f "$1" ]; then
    echo "true"
  else
    echo "false"
  fi
}

check_process() {
  if pgrep -f "automaton.*--run" > /dev/null 2>&1; then
    echo "true"
  else
    echo "false"
  fi
}

check_db_size() {
  if [ -f "$DB_PATH" ]; then
    stat --format="%s" "$DB_PATH" 2>/dev/null || stat -f "%z" "$DB_PATH" 2>/dev/null || echo "0"
  else
    echo "0"
  fi
}

# Build JSON output
cat << HEALTH_JSON
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "process_running": $(check_process),
  "database_exists": $(check_file "$DB_PATH"),
  "database_size_bytes": $(check_db_size),
  "wallet_exists": $(check_file "$WALLET_PATH"),
  "config_dir_exists": $(check_file "$AUTOMATON_DIR/config.json"),
  "node_version": "$(node --version 2>/dev/null || echo 'not found')",
  "disk_free_mb": $(df -m "${AUTOMATON_DIR}" 2>/dev/null | tail -1 | awk '{print $4}' || echo "0"),
  "memory_used_mb": $(ps -o rss= -p $(pgrep -f "automaton.*--run" 2>/dev/null | head -1) 2>/dev/null | awk '{printf "%d", $1/1024}' || echo "0")
}
HEALTH_JSON
