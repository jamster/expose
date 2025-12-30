#!/usr/bin/env bun

/**
 * expose - Expose local directories to the internet via Cloudflare Tunnel
 *
 * A clean, deterministic CLI for instantly publishing local directories
 * with automatic server detection and Cloudflare Tunnel routing.
 *
 * @version 1.0.0
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

// ============================================================================
// Type Definitions
// ============================================================================

type ServerType =
  | 'static'
  | 'node'
  | 'bun'
  | 'python-http'
  | 'python-app'
  | 'rails'
  | 'sinatra'
  | 'react'
  | 'external';

type TunnelMode = 'managed' | 'dedicated';

interface Config {
  domain: string;
  tunnelName: string;
  basePort: number;
}

interface State {
  tunnels: {
    [name: string]: {
      id: string;
      pid: number | null;
      status: 'running' | 'stopped';
      configPath: string;
    };
  };
  servers: {
    [key: string]: {
      subdomain: string;
      domain: string;
      hostname: string;
      path: string;
      port: number;
      pid: number;
      serverType: ServerType;
      tunnelMode: TunnelMode;
      tunnelName: string;
      url: string;
      started: string;
    };
  };
}

interface ParsedHostname {
  subdomain: string;
  domain: string;
  hostname: string;
  key: string;
}

interface ServerDetectionResult {
  type: ServerType;
  command: string;
  args: string[];
  port: number;
}

interface CloudflareTunnelConfig {
  tunnel: string;
  'credentials-file': string;
  ingress: Array<{
    hostname: string;
    service: string;
  } | {
    service: string;
  }>;
}

// ============================================================================
// Configuration
// ============================================================================

const EXPOSE_DIR = join(homedir(), '.expose');
const STATE_FILE = join(EXPOSE_DIR, 'state.json');
const CONFIG_FILE = join(EXPOSE_DIR, 'config.json');
const LOGS_DIR = join(EXPOSE_DIR, 'logs');

// Get the directory where this script is located (for finding static-server.ts)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Default configuration
const DEFAULT_CONFIG: Config = {
  domain: 'example.com',
  tunnelName: 'expose-tunnel',
  basePort: 3000,
};

/**
 * Load configuration from file or environment
 */
function loadConfig(): Config {
  // Environment variables take precedence
  const envDomain = process.env.EXPOSE_DOMAIN;
  const envTunnel = process.env.EXPOSE_TUNNEL_NAME;
  const envPort = process.env.EXPOSE_BASE_PORT;

  // Try to load from config file
  let fileConfig: Partial<Config> = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      fileConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    } catch (error) {
      // Ignore invalid config file
    }
  }

  return {
    domain: envDomain || fileConfig.domain || DEFAULT_CONFIG.domain,
    tunnelName: envTunnel || fileConfig.tunnelName || DEFAULT_CONFIG.tunnelName,
    basePort: envPort ? parseInt(envPort) : (fileConfig.basePort || DEFAULT_CONFIG.basePort),
  };
}

/**
 * Save configuration to file
 */
function saveConfig(config: Config): void {
  initializeExposeDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Load config once at startup
const CONFIG = loadConfig();
const DOMAIN = CONFIG.domain;
const MANAGED_TUNNEL_NAME = CONFIG.tunnelName;
const BASE_PORT = CONFIG.basePort;

// ============================================================================
// State Management
// ============================================================================

/**
 * Initialize expose directory structure
 */
function initializeExposeDir(): void {
  if (!existsSync(EXPOSE_DIR)) {
    mkdirSync(EXPOSE_DIR, { recursive: true });
  }
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
}

/**
 * Load state from disk
 */
function loadState(): State {
  initializeExposeDir();

  if (!existsSync(STATE_FILE)) {
    return {
      tunnels: {},
      servers: {},
    };
  }

  try {
    const content = readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error('Error: Failed to parse state file');
    console.error('Try deleting ~/.expose/state.json and try again');
    process.exit(1);
  }
}

/**
 * Save state to disk
 */
function saveState(state: State): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('Error: Failed to save state file');
    process.exit(1);
  }
}

/**
 * Get next available port
 */
function getNextAvailablePort(state: State): number {
  const usedPorts = Object.values(state.servers).map(s => s.port);
  let port = BASE_PORT;
  while (usedPorts.includes(port)) {
    port++;
  }
  return port;
}

/**
 * Parse hostname input into subdomain and domain
 * Examples:
 *   "test" -> { subdomain: "test", domain: "jayamster.com", hostname: "test.jayamster.com" }
 *   "test.fucksafety.com" -> { subdomain: "test", domain: "fucksafety.com", hostname: "test.fucksafety.com" }
 *   "api.staging.mysite.io" -> { subdomain: "api.staging", domain: "mysite.io", hostname: "api.staging.mysite.io" }
 */
function parseHostname(input: string): ParsedHostname {
  // Check if input contains a dot (indicating a full hostname)
  const parts = input.split('.');

  if (parts.length === 1) {
    // Simple subdomain like "test" -> use default domain
    return {
      subdomain: input,
      domain: DOMAIN,
      hostname: `${input}.${DOMAIN}`,
      key: input,
    };
  }

  if (parts.length === 2) {
    // Could be "test.com" (domain only) or "sub.domain" (ambiguous)
    // Treat as subdomain.domain - user wants subdomain on a TLD
    // e.g., "test.com" -> subdomain: "test", domain: "com" (probably not intended)
    // More likely: user means "api.mysite" where mysite is shorthand
    // Let's require at least 3 parts for explicit domain, otherwise use default
    return {
      subdomain: input,
      domain: DOMAIN,
      hostname: `${input}.${DOMAIN}`,
      key: input,
    };
  }

  // 3+ parts: treat last two as domain, rest as subdomain
  // e.g., "test.fucksafety.com" -> subdomain: "test", domain: "fucksafety.com"
  // e.g., "api.staging.mysite.io" -> subdomain: "api.staging", domain: "mysite.io"
  const domain = parts.slice(-2).join('.');
  const subdomain = parts.slice(0, -2).join('.');

  return {
    subdomain,
    domain,
    hostname: input,
    key: input.replace(/\./g, '-'), // Use as state key (dots replaced with dashes)
  };
}

// ============================================================================
// Server Detection
// ============================================================================

/**
 * Detect server type and generate start command
 */
function detectServerType(directory: string, port: number): ServerDetectionResult {
  const cwd = resolve(directory);

  // Check for React (package.json with react dependency)
  const packageJsonPath = join(cwd, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

      // React project
      if (packageJson.dependencies?.react || packageJson.devDependencies?.react) {
        // Check for Vite
        if (packageJson.dependencies?.vite || packageJson.devDependencies?.vite) {
          return {
            type: 'react',
            command: 'bun',
            args: ['run', 'dev', '--host', '0.0.0.0', '--port', port.toString()],
            port,
          };
        }
        // Check for Create React App
        if (packageJson.dependencies?.['react-scripts']) {
          return {
            type: 'react',
            command: 'PORT=' + port + ' bun',
            args: ['run', 'start'],
            port,
          };
        }
      }

      // Node.js with start script
      if (packageJson.scripts?.start) {
        return {
          type: 'node',
          command: 'bun',
          args: ['run', 'start'],
          port,
        };
      }
    } catch (error) {
      // Invalid package.json, continue to other checks
    }
  }

  // Check for Bun server
  if (existsSync(join(cwd, 'server.ts')) || existsSync(join(cwd, 'server.js'))) {
    const serverFile = existsSync(join(cwd, 'server.ts')) ? 'server.ts' : 'server.js';
    return {
      type: 'bun',
      command: 'bun',
      args: ['run', serverFile],
      port,
    };
  }

  // Check for Ruby on Rails
  if (existsSync(join(cwd, 'config', 'application.rb')) && existsSync(join(cwd, 'Gemfile'))) {
    return {
      type: 'rails',
      command: 'rails',
      args: ['server', '-p', port.toString(), '-b', '0.0.0.0'],
      port,
    };
  }

  // Check for Sinatra (config.ru or app.rb with sinatra gem)
  if (existsSync(join(cwd, 'config.ru'))) {
    return {
      type: 'sinatra',
      command: 'rackup',
      args: ['-p', port.toString(), '-o', '0.0.0.0'],
      port,
    };
  }

  // Check for Python app (app.py or main.py)
  if (existsSync(join(cwd, 'app.py'))) {
    return {
      type: 'python-app',
      command: 'python3',
      args: ['app.py'],
      port,
    };
  }

  if (existsSync(join(cwd, 'main.py'))) {
    // Check if it's a FastAPI/uvicorn app
    const mainContent = readFileSync(join(cwd, 'main.py'), 'utf-8');
    if (mainContent.includes('FastAPI') || mainContent.includes('fastapi')) {
      return {
        type: 'python-app',
        command: 'uvicorn',
        args: ['main:app', '--host', '0.0.0.0', '--port', port.toString()],
        port,
      };
    }
    return {
      type: 'python-app',
      command: 'python3',
      args: ['main.py'],
      port,
    };
  }

  // Check for static HTML
  if (existsSync(join(cwd, 'index.html'))) {
    const staticServerPath = join(__dirname, 'static-server.ts');
    return {
      type: 'static',
      command: 'bun',
      args: ['run', staticServerPath, port.toString(), cwd],
      port,
    };
  }

  // Default to static file server
  const staticServerPath = join(__dirname, 'static-server.ts');
  return {
    type: 'static',
    command: 'bun',
    args: ['run', staticServerPath, port.toString(), cwd],
    port,
  };
}

// ============================================================================
// Cloudflare Tunnel Management
// ============================================================================

/**
 * Check if cloudflared is installed
 */
function checkCloudflared(): boolean {
  try {
    const result = Bun.spawnSync(['which', 'cloudflared']);
    return result.exitCode === 0;
  } catch (error) {
    return false;
  }
}

/**
 * Get existing tunnel by name
 */
function getTunnelId(name: string): string | null {
  try {
    const result = Bun.spawnSync(['cloudflared', 'tunnel', 'list', '--output', 'json']);
    if (result.exitCode !== 0) {
      return null;
    }

    const output = result.stdout.toString();
    const tunnels = JSON.parse(output);

    const tunnel = tunnels.find((t: any) => t.name === name);
    return tunnel ? tunnel.id : null;
  } catch (error) {
    return null;
  }
}

/**
 * Create a new Cloudflare Tunnel
 */
function createTunnel(name: string): string | null {
  console.error(`Creating Cloudflare Tunnel: ${name}...`);

  try {
    const result = Bun.spawnSync(['cloudflared', 'tunnel', 'create', name]);
    if (result.exitCode !== 0) {
      console.error('Error: Failed to create tunnel');
      console.error(result.stderr.toString());
      return null;
    }

    // Get the tunnel ID
    return getTunnelId(name);
  } catch (error) {
    console.error('Error: Failed to create tunnel');
    return null;
  }
}

/**
 * Ensure managed tunnel exists
 */
function ensureManagedTunnel(state: State): string {
  const tunnelId = getTunnelId(MANAGED_TUNNEL_NAME);

  if (tunnelId) {
    console.error(`Using existing tunnel: ${MANAGED_TUNNEL_NAME} (${tunnelId})`);
    return tunnelId;
  }

  // Create new tunnel
  const newTunnelId = createTunnel(MANAGED_TUNNEL_NAME);
  if (!newTunnelId) {
    console.error('Error: Failed to ensure managed tunnel exists');
    process.exit(1);
  }

  return newTunnelId;
}

/**
 * Generate Cloudflare Tunnel config
 */
function generateTunnelConfig(state: State, tunnelId: string): CloudflareTunnelConfig {
  const credentialsFile = join(homedir(), '.cloudflared', `${tunnelId}.json`);

  const ingress: CloudflareTunnelConfig['ingress'] = [];

  // Add all active servers
  for (const [key, server] of Object.entries(state.servers)) {
    if (server.tunnelMode === 'managed' && server.tunnelName === MANAGED_TUNNEL_NAME) {
      ingress.push({
        hostname: server.hostname,
        service: `http://localhost:${server.port}`,
      });
    }
  }

  // Catch-all service (required by Cloudflare)
  ingress.push({
    service: 'http_status:404',
  });

  return {
    tunnel: tunnelId,
    'credentials-file': credentialsFile,
    ingress,
  };
}

/**
 * Write tunnel config to file
 */
function writeTunnelConfig(config: CloudflareTunnelConfig, configPath: string): void {
  // Convert to YAML manually (simple key-value structure)
  const yaml = `tunnel: ${config.tunnel}
credentials-file: ${config['credentials-file']}

ingress:
${config.ingress.map(rule => {
    if ('hostname' in rule) {
      return `  - hostname: ${rule.hostname}\n    service: ${rule.service}`;
    } else {
      return `  - service: ${rule.service}`;
    }
  }).join('\n')}
`;

  writeFileSync(configPath, yaml);
}

/**
 * Start managed tunnel
 */
function startManagedTunnel(state: State, tunnelId: string): number {
  const configPath = join(EXPOSE_DIR, 'tunnel-config.yml');
  const config = generateTunnelConfig(state, tunnelId);
  writeTunnelConfig(config, configPath);

  console.error(`Starting managed tunnel with config: ${configPath}`);

  const tunnelProcess = spawn('cloudflared', ['tunnel', '--config', configPath, 'run', tunnelId], {
    detached: true,
    stdio: 'ignore',
  });

  tunnelProcess.unref();

  return tunnelProcess.pid!;
}

/**
 * Restart managed tunnel with updated config
 */
function restartManagedTunnel(state: State, tunnelId: string): void {
  const tunnel = state.tunnels[MANAGED_TUNNEL_NAME];

  // Stop existing tunnel
  if (tunnel && tunnel.pid) {
    try {
      process.kill(tunnel.pid, 'SIGTERM');
    } catch (error) {
      // Process might already be dead
    }
  }

  // Start new tunnel
  const pid = startManagedTunnel(state, tunnelId);

  // Update state
  state.tunnels[MANAGED_TUNNEL_NAME] = {
    id: tunnelId,
    pid,
    status: 'running',
    configPath: join(EXPOSE_DIR, 'tunnel-config.yml'),
  };

  saveState(state);
}

/**
 * Route hostname to tunnel
 */
function routeHostnameToDNS(tunnelName: string, hostname: string): void {
  console.error(`Routing DNS: ${hostname} → ${tunnelName}`);

  const result = Bun.spawnSync(['cloudflared', 'tunnel', 'route', 'dns', tunnelName, hostname]);

  if (result.exitCode !== 0) {
    console.error(`Warning: Failed to route DNS (might already exist)`);
  }
}

// ============================================================================
// Server Management
// ============================================================================

/**
 * Start a server in the current directory, or expose an existing service
 */
function startServer(
  hostnameInput: string,
  directory: string,
  dedicated: boolean,
  externalPort?: number
): void {
  const state = loadState();
  const parsed = parseHostname(hostnameInput);

  // Check if hostname already exists
  if (state.servers[parsed.key]) {
    console.error(`Error: '${parsed.hostname}' is already in use`);
    console.error(`Run 'expose stop ${hostnameInput}' first`);
    process.exit(1);
  }

  // Check cloudflared
  if (!checkCloudflared()) {
    console.error('Error: cloudflared is not installed');
    console.error('Install with: brew install cloudflare/cloudflare/cloudflared');
    process.exit(1);
  }

  let port: number;
  let serverType: ServerType;
  let serverPid: number;
  const logFile = join(LOGS_DIR, `${parsed.key}.log`);

  if (externalPort) {
    // Expose an existing service running on the specified port
    port = externalPort;
    serverType = 'external';
    serverPid = 0; // We don't manage this process
    console.error(`Exposing existing service on port ${port}...`);
  } else {
    // Get next available port
    port = getNextAvailablePort(state);

    // Detect server type
    console.error(`Detecting server type in ${directory}...`);
    const detection = detectServerType(directory, port);
    console.error(`Detected: ${detection.type}`);
    serverType = detection.type;

    // Start the server
    console.error(`Starting ${detection.type} server on port ${port}...`);

    const serverProcess = spawn(detection.command, detection.args, {
      cwd: directory,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Redirect logs
    const logStream = Bun.file(logFile).writer();
    serverProcess.stdout?.on('data', (data) => {
      logStream.write(data);
    });
    serverProcess.stderr?.on('data', (data) => {
      logStream.write(data);
    });

    serverProcess.unref();
    serverPid = serverProcess.pid!;
  }

  // Setup tunnel
  const tunnelMode: TunnelMode = dedicated ? 'dedicated' : 'managed';
  const tunnelName = dedicated ? `${parsed.key}-tunnel` : MANAGED_TUNNEL_NAME;

  let tunnelId: string;

  if (dedicated) {
    // Create dedicated tunnel
    tunnelId = createTunnel(tunnelName)!;
    if (!tunnelId) {
      process.kill(serverPid, 'SIGTERM');
      console.error('Error: Failed to create dedicated tunnel');
      process.exit(1);
    }

    // Start dedicated tunnel
    const dedicatedConfig: CloudflareTunnelConfig = {
      tunnel: tunnelId,
      'credentials-file': join(homedir(), '.cloudflared', `${tunnelId}.json`),
      ingress: [
        {
          hostname: parsed.hostname,
          service: `http://localhost:${port}`,
        },
        {
          service: 'http_status:404',
        },
      ],
    };

    const dedicatedConfigPath = join(EXPOSE_DIR, `tunnel-${parsed.key}.yml`);
    writeTunnelConfig(dedicatedConfig, dedicatedConfigPath);

    const tunnelProcess = spawn('cloudflared', ['tunnel', '--config', dedicatedConfigPath, 'run', tunnelId], {
      detached: true,
      stdio: 'ignore',
    });

    tunnelProcess.unref();

    state.tunnels[tunnelName] = {
      id: tunnelId,
      pid: tunnelProcess.pid!,
      status: 'running',
      configPath: dedicatedConfigPath,
    };

    routeHostnameToDNS(tunnelName, parsed.hostname);
  } else {
    // Use managed tunnel
    tunnelId = ensureManagedTunnel(state);

    // Add server to state first
    const url = `https://${parsed.hostname}`;
    state.servers[parsed.key] = {
      subdomain: parsed.subdomain,
      domain: parsed.domain,
      hostname: parsed.hostname,
      path: directory,
      port,
      pid: serverPid,
      serverType,
      tunnelMode,
      tunnelName,
      url,
      started: new Date().toISOString(),
    };

    // Restart managed tunnel with new config
    restartManagedTunnel(state, tunnelId);

    // Route DNS
    routeHostnameToDNS(tunnelName, parsed.hostname);
  }

  // Save final state
  const url = `https://${parsed.hostname}`;

  state.servers[parsed.key] = {
    subdomain: parsed.subdomain,
    domain: parsed.domain,
    hostname: parsed.hostname,
    path: directory,
    port,
    pid: serverPid,
    serverType,
    tunnelMode,
    tunnelName,
    url,
    started: new Date().toISOString(),
  };

  saveState(state);

  console.log(JSON.stringify({
    hostname: parsed.hostname,
    url,
    port,
    type: serverType,
    tunnelMode,
    ...(serverType !== 'external' ? { logFile } : {}),
  }, null, 2));
}

/**
 * Find server by input (can be key, hostname, or subdomain)
 */
function findServerKey(state: State, input: string): string | null {
  const parsed = parseHostname(input);

  // Try exact key match first
  if (state.servers[parsed.key]) {
    return parsed.key;
  }

  // Try finding by hostname
  for (const [key, server] of Object.entries(state.servers)) {
    if (server.hostname === parsed.hostname || server.hostname === input) {
      return key;
    }
  }

  // Try finding by subdomain (for backward compatibility)
  for (const [key, server] of Object.entries(state.servers)) {
    if (server.subdomain === input || key === input) {
      return key;
    }
  }

  return null;
}

/**
 * Stop a running server
 */
function stopServer(hostnameInput: string): void {
  const state = loadState();

  const serverKey = findServerKey(state, hostnameInput);
  if (!serverKey) {
    console.error(`Error: No server found for '${hostnameInput}'`);
    process.exit(1);
  }

  const server = state.servers[serverKey];

  // Stop the server process (skip for external services)
  if (server.pid && server.pid > 0) {
    try {
      process.kill(server.pid, 'SIGTERM');
      console.error(`Stopped server: ${server.hostname} (PID ${server.pid})`);
    } catch (error) {
      console.error(`Warning: Failed to kill process ${server.pid} (might already be dead)`);
    }
  } else {
    console.error(`Removing tunnel for external service: ${server.hostname}`);
  }

  // Remove from state
  delete state.servers[serverKey];

  // If using dedicated tunnel, stop it
  if (server.tunnelMode === 'dedicated') {
    const tunnel = state.tunnels[server.tunnelName];
    if (tunnel && tunnel.pid) {
      try {
        process.kill(tunnel.pid, 'SIGTERM');
        console.error(`Stopped tunnel: ${server.tunnelName} (PID ${tunnel.pid})`);
      } catch (error) {
        console.error(`Warning: Failed to kill tunnel process`);
      }
    }
    delete state.tunnels[server.tunnelName];
  } else {
    // Restart managed tunnel with updated config
    const managedTunnel = state.tunnels[MANAGED_TUNNEL_NAME];
    if (managedTunnel) {
      restartManagedTunnel(state, managedTunnel.id);
    }
  }

  saveState(state);

  console.log(JSON.stringify({
    hostname: server.hostname,
    status: 'stopped',
  }, null, 2));
}

/**
 * List all running servers
 */
function listServers(): void {
  const state = loadState();

  if (Object.keys(state.servers).length === 0) {
    console.log(JSON.stringify({
      servers: [],
      message: 'No servers currently running',
    }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    servers: Object.values(state.servers),
  }, null, 2));
}

/**
 * Show tunnel status
 */
function showStatus(): void {
  const state = loadState();

  console.log(JSON.stringify({
    tunnels: state.tunnels,
    servers: state.servers,
    stateFile: STATE_FILE,
  }, null, 2));
}

/**
 * Show logs for a subdomain
 */
function showLogs(subdomain: string): void {
  const state = loadState();

  const server = state.servers[subdomain];
  if (!server) {
    console.error(`Error: No server found for subdomain '${subdomain}'`);
    process.exit(1);
  }

  const logFile = join(LOGS_DIR, `${subdomain}.log`);

  if (!existsSync(logFile)) {
    console.error(`Error: Log file not found: ${logFile}`);
    process.exit(1);
  }

  const logs = readFileSync(logFile, 'utf-8');
  console.log(logs);
}

// ============================================================================
// Web Dashboard
// ============================================================================

/**
 * Generate dashboard HTML
 */
function generateDashboardHTML(state: State): string {
  const servers = Object.values(state.servers);

  const serverRows = servers.length > 0
    ? servers.map(s => `
        <tr>
          <td>
            <a href="${s.url}" target="_blank" class="subdomain">${s.subdomain}</a>
          </td>
          <td><a href="${s.url}" target="_blank">${s.url}</a></td>
          <td><code>${s.port}</code></td>
          <td><span class="badge badge-${s.serverType}">${s.serverType}</span></td>
          <td><span class="badge badge-mode">${s.tunnelMode}</span></td>
          <td><code>${s.path}</code></td>
          <td>${new Date(s.started).toLocaleString()}</td>
          <td>
            <button class="btn btn-danger" onclick="stopServer('${s.subdomain}')">Stop</button>
          </td>
        </tr>
      `).join('')
    : '<tr><td colspan="8" class="empty">No servers running</td></tr>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>expose dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #e0e0e0;
      min-height: 100vh;
      padding: 2rem;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid #333;
    }
    h1 { font-size: 1.5rem; font-weight: 600; }
    h1 span { color: #f97316; }
    .config-info {
      display: flex;
      gap: 1rem;
      font-size: 0.875rem;
      color: #888;
    }
    .config-info code {
      background: #1a1a1a;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      color: #10b981;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #111;
      border-radius: 8px;
      overflow: hidden;
    }
    th, td {
      padding: 1rem;
      text-align: left;
      border-bottom: 1px solid #222;
    }
    th {
      background: #1a1a1a;
      font-weight: 500;
      color: #888;
      text-transform: uppercase;
      font-size: 0.75rem;
      letter-spacing: 0.05em;
    }
    tr:hover { background: #1a1a1a; }
    a {
      color: #3b82f6;
      text-decoration: none;
    }
    a:hover { text-decoration: underline; }
    .subdomain {
      font-weight: 600;
      color: #f97316;
    }
    code {
      font-family: 'SF Mono', Monaco, Consolas, monospace;
      font-size: 0.875rem;
      color: #a0a0a0;
    }
    .badge {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 500;
      text-transform: uppercase;
    }
    .badge-static { background: #1e3a5f; color: #60a5fa; }
    .badge-react { background: #1e3a5f; color: #61dafb; }
    .badge-node { background: #1e3a2f; color: #68a063; }
    .badge-bun { background: #2d2d1f; color: #fbf0df; }
    .badge-rails { background: #3a1e1e; color: #cc0000; }
    .badge-sinatra { background: #1e2a3a; color: #999; }
    .badge-python-app { background: #2d3a1e; color: #ffd43b; }
    .badge-python-http { background: #2d3a1e; color: #ffd43b; }
    .badge-external { background: #3a2d1e; color: #f97316; }
    .badge-mode { background: #2d1e3a; color: #a855f7; }
    .btn {
      padding: 0.5rem 1rem;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 500;
      transition: opacity 0.2s;
    }
    .btn:hover { opacity: 0.8; }
    .btn-danger { background: #dc2626; color: white; }
    .btn-refresh { background: #1a1a1a; color: #e0e0e0; border: 1px solid #333; }
    .empty {
      text-align: center;
      color: #666;
      padding: 3rem !important;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .stat {
      background: #111;
      padding: 1.5rem;
      border-radius: 8px;
      border: 1px solid #222;
    }
    .stat-value {
      font-size: 2rem;
      font-weight: 700;
      color: #f97316;
    }
    .stat-label {
      color: #888;
      font-size: 0.875rem;
      margin-top: 0.25rem;
    }
    .actions {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1><span>expose</span> dashboard</h1>
      <div class="config-info">
        <span>Domain: <code>${DOMAIN}</code></span>
        <span>Tunnel: <code>${MANAGED_TUNNEL_NAME}</code></span>
      </div>
    </header>

    <div class="stats">
      <div class="stat">
        <div class="stat-value">${servers.length}</div>
        <div class="stat-label">Active Servers</div>
      </div>
      <div class="stat">
        <div class="stat-value">${Object.keys(state.tunnels).length}</div>
        <div class="stat-label">Tunnels</div>
      </div>
      <div class="stat">
        <div class="stat-value">${servers.filter(s => s.tunnelMode === 'managed').length}</div>
        <div class="stat-label">Managed</div>
      </div>
      <div class="stat">
        <div class="stat-value">${servers.filter(s => s.tunnelMode === 'dedicated').length}</div>
        <div class="stat-label">Dedicated</div>
      </div>
    </div>

    <div class="actions">
      <button class="btn btn-refresh" onclick="location.reload()">↻ Refresh</button>
    </div>

    <table>
      <thead>
        <tr>
          <th>Subdomain</th>
          <th>URL</th>
          <th>Port</th>
          <th>Framework</th>
          <th>Mode</th>
          <th>Path</th>
          <th>Started</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${serverRows}
      </tbody>
    </table>
  </div>

  <script>
    async function stopServer(subdomain) {
      if (!confirm('Stop server ' + subdomain + '?')) return;

      try {
        const res = await fetch('/api/stop/' + subdomain, { method: 'POST' });
        if (res.ok) {
          location.reload();
        } else {
          alert('Failed to stop server');
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    // Auto-refresh every 10 seconds
    setTimeout(() => location.reload(), 10000);
  </script>
</body>
</html>`;
}

/**
 * Start the web dashboard
 */
function startDashboard(port: number): void {
  console.error(`Starting expose dashboard on http://localhost:${port}`);
  console.error('Press Ctrl+C to stop');

  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // API endpoints
      if (url.pathname === '/api/status') {
        const state = loadState();
        return new Response(JSON.stringify(state), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname.startsWith('/api/stop/') && req.method === 'POST') {
        const subdomain = url.pathname.replace('/api/stop/', '');
        try {
          stopServer(subdomain);
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({ error: 'Failed to stop' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // Dashboard HTML
      const state = loadState();
      const html = generateDashboardHTML(state);
      return new Response(html, {
        headers: { 'Content-Type': 'text/html' },
      });
    },
  });

  // Keep process running
  process.on('SIGINT', () => {
    console.error('\nDashboard stopped');
    process.exit(0);
  });
}

// ============================================================================
// Help Documentation
// ============================================================================

/**
 * Initialize configuration interactively
 */
function initConfig(domain?: string): void {
  initializeExposeDir();

  if (domain) {
    // Non-interactive mode
    const config: Config = {
      domain,
      tunnelName: CONFIG.tunnelName,
      basePort: CONFIG.basePort,
    };
    saveConfig(config);
    console.log(JSON.stringify({
      message: 'Configuration saved',
      config,
      configFile: CONFIG_FILE,
    }, null, 2));
    return;
  }

  // Check if already configured
  if (existsSync(CONFIG_FILE) && DOMAIN !== 'example.com') {
    console.log(JSON.stringify({
      message: 'Already configured',
      config: CONFIG,
      configFile: CONFIG_FILE,
    }, null, 2));
    return;
  }

  console.error('expose needs to be configured before first use.');
  console.error('');
  console.error('Run: expose init <your-domain.com>');
  console.error('');
  console.error('Example: expose init mycompany.com');
  console.error('');
  console.error('Or set environment variables:');
  console.error('  EXPOSE_DOMAIN=mycompany.com');
  console.error('  EXPOSE_TUNNEL_NAME=my-tunnel  (optional, default: expose-tunnel)');
  console.error('  EXPOSE_BASE_PORT=3000         (optional, default: 3000)');
  process.exit(1);
}

/**
 * Show current configuration
 */
function showConfig(): void {
  console.log(JSON.stringify({
    config: CONFIG,
    configFile: CONFIG_FILE,
    environment: {
      EXPOSE_DOMAIN: process.env.EXPOSE_DOMAIN || null,
      EXPOSE_TUNNEL_NAME: process.env.EXPOSE_TUNNEL_NAME || null,
      EXPOSE_BASE_PORT: process.env.EXPOSE_BASE_PORT || null,
    },
  }, null, 2));
}

function showHelp(): void {
  console.log(`
expose - Expose Local Directories to the Internet
==================================================

A clean, deterministic CLI for instantly publishing local directories
with automatic server detection and Cloudflare Tunnel routing.

USAGE:
  expose init <domain>                  Configure your default domain (first-time setup)
  expose start <name> [options]         Start serving current directory
  expose stop <name>                    Stop a running server
  expose list                           List all running servers
  expose status                         Show tunnel and server status
  expose logs <name>                    View logs for a server
  expose dashboard [port]               Start web UI (default: 8080)
  expose config                         Show current configuration
  expose help, --help, -h               Show this help message
  expose version, --version, -v         Show version information

OPTIONS:
  --port <port>                         Expose an existing service on this port
  --dedicated                           Create dedicated tunnel (not shared)

HOSTNAME FORMAT:
  <name> can be a simple subdomain or a full hostname:

  Simple subdomain (uses default domain):
    expose start demo              → https://demo.${DOMAIN}
    expose start api               → https://api.${DOMAIN}

  Full hostname (uses specified domain):
    expose start test.other.com    → https://test.other.com
    expose start api.staging.io    → https://api.staging.io

FIRST-TIME SETUP:
  # Configure your default Cloudflare domain
  expose init mydomain.com

  # Or use environment variables
  export EXPOSE_DOMAIN=mydomain.com
  export EXPOSE_TUNNEL_NAME=my-tunnel   # optional
  export EXPOSE_BASE_PORT=3000          # optional

EXAMPLES:
  # Using default domain (${DOMAIN}):
  expose start demo                     → https://demo.${DOMAIN}
  expose start myapp --dedicated        → https://myapp.${DOMAIN}

  # Using a different domain:
  expose start test.other.com           → https://test.other.com
  expose start api.staging.site.io      → https://api.staging.site.io

  # Expose an existing service (Docker, etc.):
  expose start ntfy --port 8090         → https://ntfy.${DOMAIN}
  expose start db.internal.io --port 5432

  # List all running servers
  expose list

  # Stop a server (by subdomain or full hostname)
  expose stop demo
  expose stop test.other.com

  # View logs
  expose logs demo

  # Check status
  expose status

OUTPUT:
  All commands return JSON to stdout
  Errors and messages go to stderr
  Exit code 0 on success, 1 on error

SERVER TYPES (Auto-detected):
  - Static HTML/CSS/JS (uses built-in Bun server)
  - Node.js (uses bun run start)
  - Bun server (server.ts/server.js)
  - Python app (app.py, main.py, FastAPI)
  - Ruby on Rails
  - Sinatra
  - React (Vite or Create React App)

TUNNEL MODES:
  - Managed (default): All servers share one tunnel
    Hostname: <name>.${DOMAIN} or custom domain
    One tunnel process handles all servers
    Easy to manage, efficient

  - Dedicated (--dedicated flag): Each server gets its own tunnel
    Hostname: <name>.${DOMAIN} or custom domain
    Independent tunnel process per server
    Better for production or distributed setups

CONFIGURATION:
  Config file: ~/.expose/config.json
  State file: ~/.expose/state.json
  Logs directory: ~/.expose/logs/
  Tunnel configs: ~/.expose/tunnel-*.yml

REQUIREMENTS:
  - Bun runtime (https://bun.sh)
  - cloudflared installed and authenticated
  - Cloudflare domain(s) configured in Cloudflare

INSTALL:
  # Via bun (recommended)
  bun add -g expose-tunnel

  # Or clone and link
  git clone https://github.com/jamster/expose.git
  cd expose && bun link

Version: 1.0.0
`);
}

function showVersion(): void {
  console.log('expose version 1.0.0');
}

// ============================================================================
// Main CLI Entry Point
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  // Handle help/version
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    return;
  }

  if (args[0] === 'version' || args[0] === '--version' || args[0] === '-v') {
    showVersion();
    return;
  }

  const command = args[0];

  switch (command) {
    case 'init': {
      const domain = args[1];
      initConfig(domain);
      break;
    }

    case 'config': {
      showConfig();
      break;
    }

    case 'start': {
      // Check if configured
      if (DOMAIN === 'example.com') {
        console.error('Error: expose is not configured');
        console.error('Run: expose init <your-domain.com>');
        process.exit(1);
      }

      const subdomain = args[1];
      if (!subdomain) {
        console.error('Error: name is required');
        console.error('Usage: expose start <name> [--port <port>] [--dedicated]');
        process.exit(1);
      }

      const dedicated = args.includes('--dedicated');
      const directory = process.cwd();

      // Parse --port flag
      const portIndex = args.indexOf('--port');
      let externalPort: number | undefined;
      if (portIndex !== -1 && args[portIndex + 1]) {
        externalPort = parseInt(args[portIndex + 1]);
        if (isNaN(externalPort) || externalPort < 1 || externalPort > 65535) {
          console.error('Error: Invalid port number');
          process.exit(1);
        }
      }

      startServer(subdomain, directory, dedicated, externalPort);
      break;
    }

    case 'stop': {
      const subdomain = args[1];
      if (!subdomain) {
        console.error('Error: subdomain is required');
        console.error('Usage: expose stop <subdomain>');
        process.exit(1);
      }

      stopServer(subdomain);
      break;
    }

    case 'list': {
      listServers();
      break;
    }

    case 'status': {
      showStatus();
      break;
    }

    case 'logs': {
      const subdomain = args[1];
      if (!subdomain) {
        console.error('Error: subdomain is required');
        console.error('Usage: expose logs <subdomain>');
        process.exit(1);
      }

      showLogs(subdomain);
      break;
    }

    case 'dashboard':
    case 'ui': {
      const port = args[1] ? parseInt(args[1]) : 8080;
      startDashboard(port);
      break;
    }

    default:
      console.error(`Error: Unknown command '${command}'`);
      console.error('Run "expose --help" for usage information');
      process.exit(1);
  }
}

// Run CLI
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
