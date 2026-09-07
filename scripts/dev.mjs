/**
 * Starts the whole local stack in one terminal: core-service, gateway, the AI
 * worker, and a static server for the widget test page.
 *
 *   npm run dev
 *
 * Containers (Postgres, Redis, ai-service) are managed separately —
 * `npm run infra:up`.
 *
 * The worker runs HERE rather than in a container locally, because
 * core-service binds to 127.0.0.1 and a container cannot reach it. In the
 * target VPS topology every service is a container — see the `vps` profile in
 * infra/podman-compose.yml.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_PORT = Number(process.env.DEMO_PORT ?? 3100);
const DEMO_DIR = path.join(ROOT, 'widget', 'demo');

const C = { core: '\x1b[36m', gateway: '\x1b[35m', demo: '\x1b[32m', err: '\x1b[31m', dim: '\x1b[90m', reset: '\x1b[0m' };
const children = [];

function run(name, args) {
  const child = spawn('npm', args, { cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const tag = `${C[name]}[${name}]${C.reset} `;
  const pipe = (stream) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) process.stdout.write(tag + line + '\n');
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) process.stdout.write(`${tag}exited with code ${code}\n`);
  });
  children.push(child);
  return child;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// Serves the widget test page. Deliberately a separate origin from the gateway
// so the widget is exercised cross-origin, exactly as a real product would.
const demo = createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  const file = path.join(DEMO_DIR, url === '/' ? '/index.html' : url);
  if (!file.startsWith(DEMO_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
});

/**
 * A port clash is the single most common way this script fails — usually a
 * previous run whose children outlived it. Report it as an instruction, not as
 * an unhandled 'error' event and a stack trace.
 */
demo.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    process.stdout.write(
      `${C.err}[demo]${C.reset} port ${DEMO_PORT} is already in use — another dev server is probably still running.\n` +
        `${C.dim}       Windows: netstat -ano | findstr :${DEMO_PORT}   then  taskkill /PID <pid> /F${C.reset}\n` +
        `${C.dim}       or run with a different port:  DEMO_PORT=3200 npm run dev${C.reset}\n`,
    );
  } else {
    process.stdout.write(`${C.err}[demo]${C.reset} ${err.message}\n`);
  }
  shutdown(1);
});

demo.listen(DEMO_PORT, () => {
  process.stdout.write(`${C.demo}[demo]${C.reset} test page  http://localhost:${DEMO_PORT}\n`);
});

run('core', ['run', 'dev:core']);
run('gateway', ['run', 'dev:gateway']);
// Consumes ai.jobs. Harmless if the AI dispatcher is disabled: it simply idles.
run('worker', ['run', 'dev:worker']);

/**
 * Terminate the whole process tree.
 *
 * On Windows `child.kill()` only kills the cmd.exe that `shell: true` spawned —
 * the npm and node grandchildren survive and keep holding their ports, which
 * makes the *next* `npm run dev` fail with EADDRINUSE. taskkill /T kills the
 * tree.
 */
let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.pid === undefined || child.exitCode !== null) continue;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: true });
    } else {
      child.kill('SIGTERM');
    }
  }
  demo.close();
  setTimeout(() => process.exit(code), 600).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => shutdown(0));
