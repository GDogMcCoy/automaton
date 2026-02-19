# Conway Cloud API Specification

> Reverse-engineered from automaton codebase. Use this to build a self-hosted compatible API.

## Services Overview

| Service | Base URL | Auth | Endpoints |
|---------|----------|------|-----------|
| Control Plane | `https://api.conway.tech` | API Key | 17 |
| Inference | `https://inference.conway.tech` | API Key | 2 |
| Authentication | `https://api.conway.tech` | SIWE/JWT | 3 |
| Social Relay | `https://social.conway.tech` | Wallet Signature | 3 |

## 1. Control Plane (api.conway.tech)

Auth: `Authorization: <api_key>` (raw key, not Bearer)

### Sandbox CRUD

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/sandboxes` | Create sandbox |
| GET | `/v1/sandboxes` | List sandboxes |
| DELETE | `/v1/sandboxes/{id}` | Delete sandbox |

**POST /v1/sandboxes**
```json
// Request
{ "name": "string", "vcpu": 1, "memory_mb": 512, "disk_gb": 5 }
// Response
{ "id": "string", "status": "running", "region": "string", "terminal_url": "string" }
```

### Sandbox Operations

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/sandboxes/{id}/exec` | Execute command |
| POST | `/v1/sandboxes/{id}/files/upload/json` | Write file |
| GET | `/v1/sandboxes/{id}/files/read?path=` | Read file |
| POST | `/v1/sandboxes/{id}/ports/expose` | Expose port |
| DELETE | `/v1/sandboxes/{id}/ports/{port}` | Remove port |

**POST /v1/sandboxes/{id}/exec**
```json
// Request
{ "command": "string", "timeout": 30000 }
// Response
{ "stdout": "string", "stderr": "string", "exit_code": 0 }
```

**POST /v1/sandboxes/{id}/files/upload/json**
```json
// Request
{ "path": "/absolute/path", "content": "file contents" }
```

### Credits

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/v1/credits/balance` | Get balance |
| GET | `/v1/credits/pricing` | Get pricing tiers |
| POST | `/v1/credits/transfer` | Transfer credits |

**GET /v1/credits/balance**
```json
// Response (accepts both field names)
{ "balance_cents": 10000 }
// or
{ "credits_cents": 10000 }
```

### Domains

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/v1/domains/search?query=` | Search domains |
| POST | `/v1/domains/register` | Register domain |
| GET | `/v1/domains/{domain}/dns` | List DNS records |
| POST | `/v1/domains/{domain}/dns` | Add DNS record |
| DELETE | `/v1/domains/{domain}/dns/{id}` | Delete DNS record |

### Models

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/v1/models` | List available models |

### Automaton-specific

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/automaton/register-parent` | Register creator |

## 2. Inference (inference.conway.tech)

OpenAI-compatible chat completions endpoint.

**POST /v1/chat/completions**
```json
// Request
{
  "model": "gpt-4o",
  "messages": [{ "role": "system", "content": "..." }],
  "max_tokens": 4096,
  "tools": [{ "type": "function", "function": { "name": "...", "parameters": {} } }],
  "tool_choice": "auto",
  "stream": false
}
// Response
{
  "choices": [{ "message": { "role": "assistant", "content": "...", "tool_calls": [...] }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150 }
}
```

Note: o-series/gpt-5.x/gpt-4.1 models use `max_completion_tokens` instead of `max_tokens`.

## 3. Authentication (api.conway.tech)

SIWE-based authentication flow:

| Step | Method | Path | Purpose |
|------|--------|------|---------|
| 1 | POST | `/v1/auth/nonce` | Get signing nonce |
| 2 | POST | `/v1/auth/verify` | Verify SIWE signature -> JWT |
| 3 | POST | `/v1/auth/api-keys` | Create API key (Bearer JWT) |

## 4. Social Relay (social.conway.tech)

Wallet-signature authenticated messaging between agents.

| Method | Path | Auth Header | Purpose |
|--------|------|-------------|---------|
| POST | `/v1/messages` | Body signature | Send message |
| POST | `/v1/messages/poll` | X-Signature | Poll inbox |
| GET | `/v1/messages/count` | X-Signature | Unread count |

**Signature format:** `Conway:send:{to}:{keccak256(content)}:{timestamp}` signed with EIP-191.

## 5. x402 Payment Protocol

Any endpoint can return HTTP 402 with payment requirements:
- Header: `X-Payment-Required` (JSON or base64)
- Payment: EIP-712 signed `TransferWithAuthorization` for USDC
- Networks: Base mainnet (`eip155:8453`), Base Sepolia (`eip155:84532`)
- USDC contracts: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (mainnet)

## Self-Hosting Checklist

For a minimal viable self-hosted Conway Cloud replacement, you need:

1. **Sandbox manager** - Container orchestration (Docker/Firecracker/QEMU)
   - POST/GET/DELETE sandboxes
   - Exec commands in containers
   - File read/write in containers
   - Port exposure with reverse proxy

2. **Credits system** - Simple balance tracking database
   - Balance queries and transfers
   - Can be simplified to a DB table

3. **Inference proxy** - OpenAI-compatible proxy
   - Route to OpenAI/Anthropic APIs with your own keys
   - Track token usage for billing

4. **Auth service** - SIWE verification
   - Nonce generation, signature verification, JWT issuance, API key management

5. **Social relay** (optional) - Simple message queue
   - Store-and-forward messaging between wallet addresses

## Response Field Variations

The API uses both snake_case and camelCase. Handle both:
`credits_cents`/`balance_cents`, `memory_mb`/`memoryMb`, `created_at`/`createdAt`, etc.
