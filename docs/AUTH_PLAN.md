# Plan: Authentication for Expose

## Problem Statement
Exposed services need authentication options. Some apps have auth built-in, some don't. We need:
- Easy out-of-the-box solution for quick protection
- Flexibility to use different auth methods
- Per-service configuration

## Architecture Context
Currently, requests flow: `Internet → Cloudflare Tunnel → localhost:port`

Expose doesn't intercept requests - cloudflared routes directly to local services. To add auth, we either:
1. Use Cloudflare Access (at the edge)
2. Insert a local proxy between tunnel and service

---

## Option 1: Cloudflare Access (Recommended for Production)

**How it works:** Cloudflare validates auth at the edge before requests reach your tunnel.

**Pros:**
- Enterprise-grade security
- Free tier available
- No local proxy overhead
- Supports OTP, OAuth, Service Tokens
- Device posture checking

**Cons:**
- Requires Cloudflare API token with Access permissions
- Policy configuration via API is complex
- OTP doesn't work well for native CLI tools

**Implementation:**
```bash
expose start myapp --access          # Enable Cloudflare Access
expose start myapp --access-emails "me@example.com,friend@example.com"
```

**Technical approach:**
1. Use Cloudflare API to create Access Application for hostname
2. Create Access Policy (allow specific emails via OTP)
3. Store access app ID in server state for cleanup on stop

**Files to modify:**
- `expose.ts`: Add `--access` flag, API calls to create/delete Access apps
- `State` interface: Add `accessAppId?: string` to server config

---

## Option 2: Local Auth Proxy (Recommended for Simplicity)

**How it works:** Expose runs a Bun proxy server that validates auth before forwarding to actual service.

**Pros:**
- Works immediately, no Cloudflare config needed
- Simple token-based or basic auth
- No external API dependencies
- Full control

**Cons:**
- Extra process per protected service
- Less sophisticated than Cloudflare Access
- Tokens stored locally

**Implementation:**
```bash
expose start myapp --auth                    # Generate random token
expose start myapp --auth-token mysecret     # Use specific token
expose start myapp --auth-basic user:pass    # Basic auth

# Access protected service
curl -H "Authorization: Bearer <token>" https://myapp.domain.com
```

**Technical approach:**
1. Create `auth-proxy.ts` - validates auth header, forwards to upstream
2. When `--auth` is used:
   - Service starts on internal port (e.g., 3100)
   - Auth proxy starts on exposed port (e.g., 3000)
   - Tunnel routes to proxy, proxy routes to service
3. Token displayed on start, stored in state

**Files to create/modify:**
- `auth-proxy.ts` (new): Bun server with auth validation
- `expose.ts`: Add `--auth` flags, spawn proxy when needed
- `State` interface: Add `authEnabled`, `authToken`, `internalPort`

---

## Option 3: Hybrid Approach (Both Options)

Support both Cloudflare Access AND local proxy:

```bash
# Quick local protection
expose start myapp --auth

# Production with Cloudflare Access
expose start myapp --access --access-emails "team@company.com"

# No auth (app handles it)
expose start myapp
```

---

## User Decisions

Based on user preferences:
1. **Default auth type:** Basic auth (browser popup support)
2. **Token visibility:** Show auth credentials in `expose list` and dashboard (CLI/dashboard are local-only)
3. **Scope:** Phase 1 only - basic auth via local proxy

---

## Implementation Plan

### New File: `auth-proxy.ts`

```typescript
// Usage: bun run auth-proxy.ts <listenPort> <upstreamPort> <authType> <authValue>
// authType: "bearer" | "basic"

const [listenPort, upstreamPort, authType, authValue] = Bun.argv.slice(2);

function validateAuth(req: Request): boolean {
  const auth = req.headers.get('authorization');
  if (!auth) return false;

  if (authType === 'bearer') {
    return auth === `Bearer ${authValue}`;
  }
  if (authType === 'basic') {
    const encoded = btoa(authValue);
    return auth === `Basic ${encoded}`;
  }
  return false;
}

Bun.serve({
  port: parseInt(listenPort),
  async fetch(req) {
    if (!validateAuth(req)) {
      return new Response('Unauthorized', {
        status: 401,
        headers: authType === 'basic'
          ? { 'WWW-Authenticate': 'Basic realm="expose"' }
          : {}
      });
    }

    // Forward to upstream
    const url = new URL(req.url);
    url.port = upstreamPort;
    return fetch(new Request(url.toString(), req));
  }
});
```

### CLI Changes

```bash
# New flags for 'expose start'
--auth                    # Enable basic auth with auto-generated user:pass
--auth <user:pass>        # Enable basic auth with specific credentials
```

### State Interface Addition

```typescript
interface ServerState {
  // ... existing fields
  authEnabled?: boolean;
  authType?: 'bearer' | 'basic';
  authValue?: string;        // token or user:pass
  internalPort?: number;     // actual service port when using proxy
}
```

### Flow When Auth Enabled

1. `expose start myapp --auth`
2. Detect server type, assign exposed port (e.g., 3000) and internal port (e.g., 3001)
3. Start actual service on internal port (3001)
4. Start auth-proxy on exposed port (3000), forwarding to internal port
5. Generate random credentials (`expose:randompass`), display to user
6. Update tunnel config to route to exposed port
7. Save auth config in state

### Output Example

```json
{
  "hostname": "myapp.jayamster.com",
  "url": "https://myapp.jayamster.com",
  "port": 3000,
  "type": "static",
  "tunnelMode": "managed",
  "auth": {
    "enabled": true,
    "type": "basic",
    "credentials": "expose:a1b2c3d4"
  }
}
```

### `expose list` Output with Auth

Shows auth status and credentials for each server:
```
myapp    https://myapp.jayamster.com    static    auth: expose:a1b2c3d4
ntfy     https://ntfy.jayamster.com     external  (no auth)
```

### Dashboard Integration

- Show auth badge/indicator per service
- Display credentials for authenticated services
- Copy credentials button

---

## Files to Modify

1. **`expose.ts`** - Main CLI
   - Add `--auth` flag parsing
   - Generate random credentials when `--auth` used without value
   - Spawn auth-proxy process for protected services
   - Update `expose list` to show auth status
   - Update dashboard HTML to show auth info

2. **`auth-proxy.ts`** (new) - Auth proxy server
   - Validate Basic auth header
   - Forward authenticated requests to upstream
   - Return 401 with WWW-Authenticate header on failure

---

## Implementation Checklist

- [ ] Create `auth-proxy.ts` in expose directory
- [ ] Add `--auth` flag to `expose start` command
- [ ] Generate random credentials function
- [ ] Spawn auth-proxy when `--auth` is used
- [ ] Track auth state (credentials, proxy PID, internal port)
- [ ] Update `expose list` JSON output with auth info
- [ ] Update dashboard HTML to show auth status
- [ ] Kill auth-proxy on `expose stop`
- [ ] Test with browser (basic auth popup) and curl
