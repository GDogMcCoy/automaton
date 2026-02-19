# Conway Automaton - Operator Runbook

Production operations guide for deploying, monitoring, and troubleshooting
a Conway Automaton instance.

---

## Table of Contents

1. [Deployment](#deployment)
2. [Configuration](#configuration)
3. [Health Monitoring](#health-monitoring)
4. [Common Operations](#common-operations)
5. [Troubleshooting](#troubleshooting)
6. [Backup & Recovery](#backup--recovery)
7. [Upgrades](#upgrades)
8. [Security](#security)

---

## Deployment

### Docker (recommended)

```bash
# Build the image
cd docker
docker build -t conway-automaton -f Dockerfile ..

# Run with docker-compose
docker-compose up -d

# Check health
curl http://localhost:8080/health
```

### Systemd (bare metal)

```bash
# Install to /opt/automaton
sudo cp -r dist/ /opt/automaton/dist/
sudo cp -r node_modules/ /opt/automaton/node_modules/
sudo cp package.json /opt/automaton/

# Create system user
sudo useradd -r -s /bin/false automaton
sudo mkdir -p /var/lib/automaton /var/log/automaton
sudo chown automaton:automaton /var/lib/automaton /var/log/automaton

# Install service
sudo cp systemd/automaton.service /etc/systemd/system/
sudo cp systemd/automaton-logrotate.conf /etc/logrotate.d/automaton
sudo systemctl daemon-reload
sudo systemctl enable automaton
sudo systemctl start automaton
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `production` | Runtime environment |
| `CONWAY_API_KEY` | — | Conway API key (can also use secrets file) |
| `CONWAY_API_URL` | `https://api.conway.tech` | Conway API endpoint |
| `HEALTH_PORT` | `8080` | Port for health/metrics HTTP server |
| `LOG_LEVEL` | `info` | Logging level: `debug`, `info`, `warn`, `error` |
| `AUTOMATON_DATA_DIR` | `~/.automaton` | Data directory path |
| `WALLET_PASSPHRASE` | — | Wallet encryption passphrase |

---

## Configuration

Configuration lives at `~/.automaton/automaton.json` (or `$AUTOMATON_DATA_DIR/automaton.json`).

### Key fields

```json
{
  "name": "my-automaton",
  "conwayApiUrl": "https://api.conway.tech",
  "conwayApiKey": "ck_...",
  "inferenceModel": "gpt-4o",
  "maxTokensPerTurn": 4096,
  "maxChildren": 3,
  "selfModMode": "disabled",
  "replicationEnabled": false,
  "maxDailySpendingUsdc": 10,
  "allowedDomains": ["api.conway.tech", "social.conway.tech"],
  "logLevel": "info"
}
```

### Secrets

Secrets are loaded in priority order:
1. **Environment variables** (highest priority)
2. **File secrets** at `/run/secrets/<name>` (Docker/K8s)
3. **JSON secrets** at `~/.automaton/secrets.json` (must be mode `0600`)

### Config reload

Send `SIGHUP` to reload config without restart:
```bash
sudo systemctl reload automaton
# or
kill -HUP $(pgrep -f "automaton.*--run")
```

---

## Health Monitoring

### Endpoints

The automaton exposes an HTTP server on `HEALTH_PORT` (default 8080):

| Endpoint | Description | Use for |
|----------|-------------|---------|
| `GET /health` | Returns `200 OK` or `503 Degraded` | Docker/K8s liveness probe |
| `GET /ready` | Returns `200` when agent loop is active | K8s readiness probe |
| `GET /metrics` | Prometheus-format metrics | Grafana/monitoring |
| `GET /.well-known/agent-card.json` | Agent card (if configured) | Agent discovery |

### Example health response

```json
{
  "status": "healthy",
  "version": "0.1.0",
  "uptime_seconds": 3600,
  "agent_state": "running",
  "timestamp": "2026-02-19T12:00:00.000Z"
}
```

### Key metrics to monitor

- `loop.turns.total` — Total inference turns executed
- `loop.turns.errors` — Turn failures (should be low)
- `loop.credits` — Current credit balance (gauge)
- `loop.cost_cents` — Cost per turn (histogram)
- `run_loop.errors` — Fatal run loop errors
- `run_loop.circuit_breaker_trips` — Circuit breaker activations (investigate immediately)
- `http.rate_limited` — Rate-limited requests to health server

### Alerting recommendations

| Metric | Threshold | Action |
|--------|-----------|--------|
| `/health` returns 503 | Any | Check DB integrity |
| `run_loop.circuit_breaker_trips > 0` | Any | Check logs for persistent failures |
| `loop.credits < 50` | Below $0.50 | Top up credits |
| `loop.turns.errors / loop.turns.total > 0.1` | >10% error rate | Check inference provider |
| Uptime < 60s (restart loop) | Repeated | Check StartLimitBurst in systemd |

---

## Common Operations

### Check status
```bash
automaton --status
# or
curl -s http://localhost:8080/health | jq
```

### View logs
```bash
# Systemd
journalctl -u automaton -f

# Docker
docker logs -f automaton

# JSON log parsing
journalctl -u automaton --output=cat | jq -r 'select(.level=="error")'
```

### Interactive database query
```bash
sqlite3 ~/.automaton/state.db
> SELECT COUNT(*) FROM turns;
> SELECT * FROM kv WHERE key LIKE 'last_%';
> SELECT version, applied_at FROM schema_version ORDER BY version;
> .quit
```

### Credit balance check
```bash
automaton --status | grep Credits
# or via API:
curl -s http://localhost:8080/metrics | grep loop_credits
```

### Force wake from sleep
```bash
sqlite3 ~/.automaton/state.db "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('wake_request', 'operator-manual', datetime('now'))"
```

---

## Troubleshooting

### Automaton won't start

1. Check config: `automaton --status`
2. Check API key: `grep conwayApiKey ~/.automaton/automaton.json | head -c 20`
3. Check DB: `sqlite3 ~/.automaton/state.db "PRAGMA integrity_check;"`
4. Check disk space: `df -h ~/.automaton`
5. Check logs: `journalctl -u automaton --since "5 minutes ago"`

### Health endpoint returns 503

The DB integrity check failed. Run:
```bash
sqlite3 ~/.automaton/state.db "PRAGMA integrity_check;"
```
If corrupt, restore from backup (see below).

### Circuit breaker tripped (10-minute cooldown)

The outer run loop hit 10 consecutive failures. Check logs:
```bash
journalctl -u automaton | grep "circuit breaker"
```
Common causes:
- Conway API unreachable
- Database corruption
- Invalid config after edit
- Disk full

### Agent stuck in "dead" state

The agent ran out of credits. Top up credits:
```bash
automaton --status  # Check credits
# Transfer credits via Conway dashboard or API
```

### High memory usage

1. Check turn history: `sqlite3 ~/.automaton/state.db "SELECT COUNT(*) FROM turns;"`
2. Run cleanup: The automaton auto-cleans turns older than 30 days on startup
3. Force cleanup: restart the automaton

### Port 8080 already in use

Set a different port:
```bash
HEALTH_PORT=9090 automaton --run
# or in systemd env file:
echo "HEALTH_PORT=9090" >> /etc/automaton/env
sudo systemctl restart automaton
```

---

## Backup & Recovery

### Create backup
```bash
./scripts/backup.sh [/path/to/backup-dir]
```
Backs up: `wallet.json`, `config.json`, `state.db`, `constitution.md`, `heartbeat.yml`, `SOUL.md`

### Restore from backup
```bash
./scripts/restore.sh /path/to/backup-directory

# Dry run (preview only):
./scripts/restore.sh /path/to/backup-directory --dry-run

# Skip confirmation:
./scripts/restore.sh /path/to/backup-directory --force
```

The restore script:
1. Verifies checksums
2. Creates a pre-restore backup of current state
3. Restores files with correct permissions
4. Runs DB integrity check

### Scheduled backups

Add to crontab:
```bash
# Daily backup at 3 AM
0 3 * * * /opt/automaton/scripts/backup.sh /backup/automaton >> /var/log/automaton-backup.log 2>&1
```

---

## Upgrades

### Rolling upgrade (Docker)

```bash
# Build new image
docker build -t conway-automaton:new -f docker/Dockerfile .

# Stop old container (graceful 30s drain)
docker stop -t 30 automaton

# Start new container
docker-compose up -d
```

### Systemd upgrade

```bash
# Build new version
pnpm install --frozen-lockfile && pnpm build

# Deploy
sudo cp -r dist/ /opt/automaton/dist/
sudo systemctl restart automaton

# Verify
curl http://localhost:8080/health
```

### Database migrations

Migrations run automatically on startup. Check migration history:
```bash
sqlite3 ~/.automaton/state.db "SELECT * FROM migration_log ORDER BY version;"
```

### Rollback

If an upgrade fails:
1. Stop the automaton
2. Restore from backup: `./scripts/restore.sh /path/to/backup`
3. Deploy the previous version
4. Start the automaton

---

## Security

### Hardening checklist

- [ ] Wallet file permissions: `chmod 600 ~/.automaton/wallet.json`
- [ ] Config file permissions: `chmod 600 ~/.automaton/automaton.json`
- [ ] `selfModMode` set to `"disabled"` (or `"gated"` with review)
- [ ] `replicationEnabled` set to `false` unless intentional
- [ ] `allowedDomains` configured to restrict outbound requests
- [ ] `maxDailySpendingUsdc` set to a reasonable limit
- [ ] `maxChildren` set to 0 if replication not needed
- [ ] Secrets stored in `/run/secrets/` or env vars, not in config file
- [ ] Health port (`8080`) not exposed to public internet
- [ ] systemd service running as non-root `automaton` user
- [ ] Docker container running as non-root user

### Constitution integrity

The automaton's constitution at `~/.automaton/constitution.md` defines its behavioral
constraints. Verify it hasn't been tampered with:
```bash
sha256sum ~/.automaton/constitution.md
```

### Audit log

Self-modification events are logged in the `modifications` table:
```bash
sqlite3 ~/.automaton/state.db "SELECT timestamp, type, description FROM modifications ORDER BY timestamp DESC LIMIT 20;"
```
