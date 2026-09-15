#!/usr/bin/env node
/**
 * Frees a TCP port before the Vite dev server or the Express API starts.
 *
 * Why this exists: when a `npm run dev` session is closed without stopping the
 * process (closing the terminal, killing VS Code, a crashed shell), Windows and
 * Unix keep the TCP listener alive. The next `npm run dev` then dies with:
 *     error when starting dev server:
 *     Error: Port 5173 is already in use
 *
 * Usage:
 *   node scripts/free-port.mjs dev       # Vite dev server port (default 5173)
 *   node scripts/free-port.mjs server    # Express API port   (default 4000)
 *   node scripts/free-port.mjs 5173      # explicit port
 *
 * Flags:
 *   --force   stop the listener even when it is not a Node process
 *
 * Port resolution order: CLI value > shell env > .env > built-in default.
 * Only Node processes are stopped by default, so unrelated applications that
 * happen to use the same port are never killed. The script always exits 0 so a
 * port problem can never block `npm run dev`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';
const DEFAULT_PORTS = { dev: 5173, server: 4000 };
const WAIT_TIMEOUT_MS = 4000;
const WAIT_INTERVAL_MS = 150;

function isPositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function readEnvFile() {
  const envPath = path.join(process.cwd(), '.env');
  const values = {};
  if (!fs.existsSync(envPath)) return values;

  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function resolvePort(argument, env) {
  const explicit = isPositiveInteger(argument);
  if (explicit) return explicit;

  if (argument === 'server') {
    return isPositiveInteger(process.env.API_PORT) || isPositiveInteger(env.API_PORT) || DEFAULT_PORTS.server;
  }

  return (
    isPositiveInteger(process.env.DEV_PORT) ||
    isPositiveInteger(process.env.VITE_DEV_PORT) ||
    isPositiveInteger(env.DEV_PORT) ||
    isPositiveInteger(env.VITE_DEV_PORT) ||
    DEFAULT_PORTS.dev
  );
}

/** Returns the PIDs of every process listening on the given TCP port. */
function listenersOnPort(port) {
  try {
    if (IS_WINDOWS) {
      const output = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
      const pids = new Set();
      for (const line of output.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const columns = line.trim().split(/\s+/);
        const localAddress = columns[1] || '';
        const pid = isPositiveInteger(columns[columns.length - 1]);
        if (localAddress.endsWith(`:${port}`) && pid) pids.add(pid);
      }
      return [...pids];
    }

    const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    return [...new Set(output.split(/\s+/).map(isPositiveInteger).filter(Boolean))];
  } catch {
    // No listener found: netstat/lsof exit non-zero when the port is free.
    return [];
  }
}

function processDetails(pid) {
  try {
    if (IS_WINDOWS) {
      const listing = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
      const image = (listing.split('","')[0] || '').replace(/^"|"$/g, '');
      let commandLine = '';
      try {
        commandLine = execFileSync(
          'powershell',
          ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
          { encoding: 'utf8', windowsHide: true },
        ).trim();
      } catch {
        commandLine = '';
      }
      return { image, commandLine };
    }

    const image = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim();
    const commandLine = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).trim();
    return { image, commandLine };
  } catch {
    return { image: '', commandLine: '' };
  }
}

function isNodeDevProcess({ image, commandLine }) {
  if (/^node(\.exe)?$/i.test(image)) return true;
  return /(^|[\\/\s])vite([\\/.]|$)|server[\\/]index\.js/i.test(commandLine);
}

function stopProcess(pid) {
  try {
    if (IS_WINDOWS) {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return true;
  } catch {
    return false;
  }
}

function waitUntilFree(port) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (listenersOnPort(port).length > 0 && Date.now() < deadline) {
    sleep(WAIT_INTERVAL_MS);
  }
  return listenersOnPort(port).length === 0;
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const portArgument = args.find((arg) => !arg.startsWith('--')) || 'dev';
  const port = resolvePort(portArgument, readEnvFile());

  const initialPids = listenersOnPort(port);
  if (initialPids.length === 0) return; // Port is free: stay quiet for a clean dev banner.

  const stopped = [];
  const skipped = [];

  for (const pid of initialPids) {
    const details = processDetails(pid);
    if (!isNodeDevProcess(details) && !force) {
      skipped.push({ pid, ...details });
      continue;
    }
    if (stopProcess(pid)) stopped.push({ pid, ...details });
    else skipped.push({ pid, ...details });
  }

  for (const entry of stopped) {
    const label = entry.commandLine || entry.image || 'node process';
    console.log(`[free-port] Stopped stale process ${entry.pid} that was holding port ${port} (${label}).`);
  }

  for (const entry of skipped) {
    const label = entry.commandLine || entry.image || `PID ${entry.pid}`;
    console.log(`[free-port] Port ${port} is still held by ${label}.`);
  }

  if (skipped.length > 0) {
    console.log('[free-port] That listener is not a Node dev process, so it was left untouched.');
    console.log('[free-port] Vite will start on the next free port instead of failing.');
    return;
  }

  if (!waitUntilFree(port)) {
    console.log(`[free-port] Port ${port} is still busy after stopping the stale listener; Vite will use the next free port.`);
  }
}

try {
  main();
} catch (error) {
  console.log(`[free-port] Skipped port cleanup: ${error instanceof Error ? error.message : String(error)}`);
}
process.exit(0);