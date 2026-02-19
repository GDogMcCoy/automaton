#!/usr/bin/env bash
# Conway Automaton Restore Script
# Restores wallet, database, and config from a backup created by backup.sh
#
# Usage:
#   ./restore.sh /path/to/backup-directory
#   ./restore.sh /path/to/backup-directory --dry-run
#   ./restore.sh /path/to/backup-directory --force

set -euo pipefail

AUTOMATON_DIR="${HOME}/.automaton"
BACKUP_PATH="${1:-}"
DRY_RUN=false
FORCE=false

# Parse flags
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --force) FORCE=true ;;
  esac
done

if [ -z "${BACKUP_PATH}" ]; then
  echo "Usage: $0 <backup-directory> [--dry-run] [--force]"
  echo ""
  echo "Options:"
  echo "  --dry-run   Show what would be restored without making changes"
  echo "  --force     Skip confirmation prompts"
  echo ""
  echo "Available backups:"
  BACKUP_BASE="${HOME}/.automaton-backups"
  if [ -d "${BACKUP_BASE}" ]; then
    ls -1t "${BACKUP_BASE}" 2>/dev/null | head -10
  else
    echo "  No backups found in ${BACKUP_BASE}"
  fi
  exit 1
fi

if [ ! -d "${BACKUP_PATH}" ]; then
  echo "ERROR: Backup directory does not exist: ${BACKUP_PATH}"
  exit 1
fi

echo "=== Conway Automaton Restore ==="
echo "Source:      ${BACKUP_PATH}"
echo "Destination: ${AUTOMATON_DIR}"
echo "Dry run:     ${DRY_RUN}"
echo ""

# Step 1: Verify checksums
echo "--- Verifying backup integrity ---"
CHECKSUM_FILE="${BACKUP_PATH}/checksums.sha256"
if [ ! -f "${CHECKSUM_FILE}" ]; then
  echo "WARNING: No checksums.sha256 found. Cannot verify backup integrity."
  if [ "${FORCE}" != "true" ] && [ "${DRY_RUN}" != "true" ]; then
    read -r -p "Continue without verification? (y/N): " confirm
    if [ "${confirm}" != "y" ] && [ "${confirm}" != "Y" ]; then
      echo "Aborted."
      exit 1
    fi
  fi
else
  cd "${BACKUP_PATH}"
  if sha256sum -c checksums.sha256 2>/dev/null; then
    echo "Checksums verified OK."
  elif shasum -a 256 -c checksums.sha256 2>/dev/null; then
    echo "Checksums verified OK."
  else
    echo "ERROR: Checksum verification FAILED."
    echo "The backup may be corrupted."
    if [ "${FORCE}" != "true" ]; then
      exit 1
    fi
    echo "WARNING: Continuing anyway due to --force flag."
  fi
fi

echo ""

# Step 2: List files to restore
echo "--- Files to restore ---"
RESTORE_FILES=()
for file in wallet.json config.json state.db constitution.md heartbeat.yml SOUL.md state.db-wal state.db-shm; do
  src="${BACKUP_PATH}/${file}"
  if [ -f "${src}" ]; then
    RESTORE_FILES+=("${file}")
    dst="${AUTOMATON_DIR}/${file}"
    if [ -f "${dst}" ]; then
      echo "  OVERWRITE: ${file}"
    else
      echo "  CREATE:    ${file}"
    fi
  fi
done

if [ ${#RESTORE_FILES[@]} -eq 0 ]; then
  echo "  No files found in backup."
  exit 1
fi

echo ""
echo "Total files: ${#RESTORE_FILES[@]}"

# Step 3: Confirm (unless --force or --dry-run)
if [ "${DRY_RUN}" = "true" ]; then
  echo ""
  echo "Dry run complete. No changes made."
  exit 0
fi

if [ "${FORCE}" != "true" ]; then
  echo ""
  echo "WARNING: This will overwrite existing files in ${AUTOMATON_DIR}"
  read -r -p "Proceed with restore? (y/N): " confirm
  if [ "${confirm}" != "y" ] && [ "${confirm}" != "Y" ]; then
    echo "Aborted."
    exit 1
  fi
fi

# Step 4: Stop the automaton if running
if pgrep -f "automaton.*--run" > /dev/null 2>&1; then
  echo ""
  echo "WARNING: Automaton process is running."
  echo "Restoring while running may cause database corruption."
  if [ "${FORCE}" != "true" ]; then
    read -r -p "Stop the automaton first? (Y/n): " confirm
    if [ "${confirm}" != "n" ] && [ "${confirm}" != "N" ]; then
      echo "Stopping automaton..."
      pkill -f "automaton.*--run" || true
      sleep 2
    fi
  fi
fi

# Step 5: Create pre-restore backup
echo ""
echo "--- Creating pre-restore backup ---"
PRE_RESTORE="${AUTOMATON_DIR}/.pre-restore-$(date -u +%Y%m%d_%H%M%S)"
mkdir -p "${PRE_RESTORE}"
for file in "${RESTORE_FILES[@]}"; do
  src="${AUTOMATON_DIR}/${file}"
  if [ -f "${src}" ]; then
    cp "${src}" "${PRE_RESTORE}/"
  fi
done
echo "Pre-restore backup saved to: ${PRE_RESTORE}"

# Step 6: Restore files
echo ""
echo "--- Restoring files ---"
mkdir -p "${AUTOMATON_DIR}"

for file in "${RESTORE_FILES[@]}"; do
  src="${BACKUP_PATH}/${file}"
  dst="${AUTOMATON_DIR}/${file}"
  cp "${src}" "${dst}"

  # Set appropriate permissions
  case "${file}" in
    wallet.json|secrets.json)
      chmod 600 "${dst}"
      echo "  Restored: ${file} (mode 600)"
      ;;
    config.json)
      chmod 600 "${dst}"
      echo "  Restored: ${file} (mode 600)"
      ;;
    state.db|state.db-wal|state.db-shm)
      chmod 640 "${dst}"
      echo "  Restored: ${file} (mode 640)"
      ;;
    *)
      chmod 644 "${dst}"
      echo "  Restored: ${file} (mode 644)"
      ;;
  esac
done

# Step 7: Verify database integrity
echo ""
echo "--- Verifying database integrity ---"
DB_PATH="${AUTOMATON_DIR}/state.db"
if [ -f "${DB_PATH}" ]; then
  if command -v sqlite3 &> /dev/null; then
    INTEGRITY=$(sqlite3 "${DB_PATH}" "PRAGMA integrity_check;" 2>&1)
    if [ "${INTEGRITY}" = "ok" ]; then
      echo "Database integrity check: PASSED"

      # Show schema version
      VERSION=$(sqlite3 "${DB_PATH}" "SELECT MAX(version) FROM schema_version;" 2>/dev/null || echo "unknown")
      echo "Database schema version: ${VERSION}"

      # Show turn count
      TURNS=$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM turns;" 2>/dev/null || echo "unknown")
      echo "Turns in database: ${TURNS}"
    else
      echo "WARNING: Database integrity check FAILED: ${INTEGRITY}"
      echo "You may need to delete state.db and let the automaton rebuild it."
    fi
  else
    echo "sqlite3 not found, skipping integrity check."
  fi
fi

echo ""
echo "=== Restore Complete ==="
echo "Pre-restore backup: ${PRE_RESTORE}"
echo ""
echo "Next steps:"
echo "  1. Review restored config: cat ${AUTOMATON_DIR}/config.json"
echo "  2. Start the automaton: automaton --run"
