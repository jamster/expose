# expose

**Instantly expose local directories to the internet via Cloudflare Tunnel.**

A clean, deterministic CLI that auto-detects your project type, starts the right server, and publishes it through Cloudflare's secure tunnel infrastructure.

## Features

- **Auto-detection** - Detects React, Node.js, Python, Rails, Sinatra, and static sites
- **Zero config** - Just run `expose start myapp` and you're live
- **Secure** - Uses Cloudflare Tunnel (no port forwarding needed)
- **Your domain** - Publish to your own domain, not random URLs
- **Web dashboard** - Monitor all exposed services in a browser
- **JSON output** - Composable with jq, grep, and other tools

## Quick Start

```bash
# Install
bun add -g expose-tunnel

# Configure your domain (one-time setup)
expose init mydomain.com

# Expose current directory
cd my-project
expose start demo
# → https://demo.mydomain.com

# View all running servers
expose list

# Open the web dashboard
expose dashboard
```

## Requirements

1. **Bun** - JavaScript runtime
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

2. **cloudflared** - Cloudflare Tunnel CLI
   ```bash
   brew install cloudflare/cloudflare/cloudflared
   cloudflared tunnel login
   ```

3. **Domain** - A domain managed by Cloudflare

## Commands

| Command | Description |
|---------|-------------|
| `expose init <domain>` | Configure your domain (first-time setup) |
| `expose start <name>` | Expose current directory as `name.yourdomain.com` |
| `expose stop <name>` | Stop an exposed server |
| `expose list` | List all running servers |
| `expose dashboard` | Open web UI on localhost:8080 |
| `expose status` | Show detailed tunnel/server status |
| `expose logs <name>` | View server logs |
| `expose config` | Show current configuration |

## Auto-Detected Server Types

| Project Type | Detection Method | Server Command |
|-------------|------------------|----------------|
| React (Vite) | `package.json` with vite | `bun run dev` |
| React (CRA) | `package.json` with react-scripts | `bun run start` |
| Node.js | `package.json` with start script | `bun run start` |
| Bun | `server.ts` or `server.js` | `bun run server.ts` |
| Rails | `config/application.rb` + `Gemfile` | `rails server` |
| Sinatra | `config.ru` | `rackup` |
| FastAPI | `main.py` with FastAPI | `uvicorn main:app` |
| Python | `app.py` or `main.py` | `python3 app.py` |
| Static | `index.html` or fallback | Built-in static server |

## Tunnel Modes

### Managed (Default)
All servers share one tunnel. Efficient and easy to manage.

```bash
expose start app1  # → https://app1.yourdomain.com
expose start app2  # → https://app2.yourdomain.com
# Both use the same tunnel process
```

### Dedicated
Each server gets its own isolated tunnel.

```bash
expose start production --dedicated
# Creates independent tunnel for production use
```

## Configuration

Configuration is stored in `~/.expose/config.json`:

```json
{
  "domain": "mydomain.com",
  "tunnelName": "expose-tunnel",
  "basePort": 3000
}
```

### Environment Variables

Override config with environment variables:

```bash
export EXPOSE_DOMAIN=mydomain.com
export EXPOSE_TUNNEL_NAME=my-tunnel
export EXPOSE_BASE_PORT=3000
```

## Web Dashboard

The dashboard provides a visual overview of all exposed services:

```bash
expose dashboard      # Opens on http://localhost:8080
expose dashboard 9000 # Custom port
```

Features:
- See all active servers at a glance
- View URLs, ports, frameworks, and paths
- Stop servers with one click
- Auto-refreshes every 10 seconds

## Examples

### Expose a React App

```bash
cd ~/projects/my-react-app
expose start demo
# Detects Vite/CRA, starts dev server
# → https://demo.mydomain.com
```

### Expose a Python API

```bash
cd ~/projects/fastapi-app
expose start api
# Detects FastAPI, starts uvicorn
# → https://api.mydomain.com
```

### Multiple Projects

```bash
# Terminal 1
cd ~/frontend && expose start frontend

# Terminal 2
cd ~/backend && expose start backend

# Both running:
# - https://frontend.mydomain.com
# - https://backend.mydomain.com
```

### Parse Output with jq

```bash
# Get all URLs
expose list | jq -r '.servers[].url'

# Check if specific server is running
expose list | jq -e '.servers[] | select(.subdomain == "demo")'

# Count running servers
expose list | jq '.servers | length'
```

## Why expose?

| Problem | Solution |
|---------|----------|
| ngrok requires accounts and has URL limits | Use your own domain |
| Manual server setup is error-prone | Auto-detection handles it |
| Port forwarding is complex and insecure | Cloudflare Tunnel is secure |
| Random URLs are unprofessional | Clean subdomains on your domain |
| No visibility into what's running | Web dashboard shows everything |

## How It Works

1. **Detection** - Scans directory for project indicators (package.json, app.py, etc.)
2. **Server** - Spawns appropriate server on next available port
3. **Tunnel** - Creates/updates Cloudflare Tunnel configuration
4. **DNS** - Routes subdomain to tunnel via Cloudflare DNS
5. **Background** - Detaches processes to run independently

## File Locations

```
~/.expose/
├── config.json        # Your configuration
├── state.json         # Running servers and tunnels
├── tunnel-config.yml  # Cloudflare tunnel config
└── logs/
    └── myapp.log      # Server logs
```

## Troubleshooting

### "cloudflared is not installed"
```bash
brew install cloudflare/cloudflare/cloudflared
cloudflared tunnel login
```

### "expose is not configured"
```bash
expose init yourdomain.com
```

### "Subdomain already in use"
```bash
expose stop existingapp
expose start existingapp
```

### Server won't start
```bash
expose logs myapp
# Check for errors
```

## License

MIT
