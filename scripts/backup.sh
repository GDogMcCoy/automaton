#!/usr/bin/env bash
# Conway Automaton Backup Script
# Creates timestamped backup of wallet, database, and config

set -euo pipefail

AUTOMATON_DIR="${HOME}/.automaton"
BACKUP_DIR="${1:-${HOME}/.automaton-backups}"
TIMESTAMP=$(date -u +%Y%m%d_%H%M%S)
BACKUP_NAME="automaton-backup-${TIMESTAMP}"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_NAME}"

echo "=== Conway Automaton Backup ==="
echo "Source: ${AUTOMATON_DIR}"
echo "Destination: ${BACKUP_PATH}"

# Create backup directory
mkdir -p "${BACKUP_PATH}"

# Backup critical files
for file in wallet.json config.json state.db constitution.md heartbeat.yml SOUL.md; do
  src="${AUTOMATON_DIR}/${file}"
  if [ -f "${src}" ]; then
    cp "${src}" "${BACKUP_PATH}/"
    echo "  Backed up: ${file}"
  fi
done

# Backup WAL files if they exist
for wal in state.db-wal state.db-shm; do
  src="${AUTOMATON_DIR}/${wal}"
  if [ -f "${src}" ]; then
    cp "${src}" "${BACKUP_PATH}/"
  fi
done

# Generate checksums
cd "${BACKUP_PATH}"
sha256sum * > checksums.sha256 2>/dev/null || shasum -a 256 * > checksums.sha256 2>/dev/null

echo ""
echo "Backup complete: ${BACKUP_PATH}"
echo "Files:"
ls -la "${BACKUP_PATH}"
echo ""
echo "Verify with: cd ${BACKUP_PATH} && sha256sum -c checksums.sha256"
