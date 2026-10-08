import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { SnapshotStore } from './snapshots.js';
import { openRepo, overview, compare, commitDetail, diff, xray, git, validRef, GitError } from './git.js';
import { analytics, fileActivity } from './analytics.js';
import { preview, execute } from './operations.js';

const root = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const allowedFiles = new Map([
  ['/', 'index.html'], ['/index.html', 'index.html'], ['/css/style.css', 'css/style.css'],
  ['/js/app.js', 'js/app.js'], ['/js/graph.js', 'js/graph.js']
]);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const token = randomBytes(32).toString('hex');
const store = new SnapshotStore(process.env.GITSCOPE_DATA_DIR || undefined);
let active = null, busy = false, polling = false;

function send(res, code, body, extra = {}) {
  const content = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(content);
}
function fail(res, e) { send(res, e.status || 500, { error: e.message || 'Unexpected error' }); }
function requireActive() { if (!active) throw new GitError('Select a repository first', 400); return active; }
function parseBody(req) {
  return new Promise((resolveBody, reject) => {
    let text = ''; req.on('data', part => { text += part; if (text.length > 16384) { reject(new GitError('Payload too large', 413)); req.destroy(); } });
    req.on('end', () => { try { const data = JSON.parse(text); if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Invalid object'); resolveBody(data); } catch { reject(new GitError('Invalid JSON request')); } });
    req.on('error', reject);
  });
}
function accessAllowed(req) {
  const origin = req.headers.origin;
  const hostname = req.headers.host;
  if (!/^((localhost)|(127\.0\.0\.1)|(\[::1\]))(:\d+)?$/.test(hostname || '')) throw new GitError('Invalid host', 403);
  if (origin && new URL(origin).host !== hostname) throw new GitError('Cross-origin request rejected', 403);
}
function canWrite(req) {
  if (req.headers['x-gitscope-token'] !== token) throw new GitError('Invalid local session token', 403);
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new GitError('Expected JSON request', 415);
}
async function currentState(url) {
  const cwd = requireActive();
  const limit = Math.min(1200, Math.max(1, Number(url.searchParams.get('limit')) || 500));
  const offset = Math.min(200000, Math.max(0, Number(url.searchParams.get('offset')) || 0));
  const response = await overview(cwd, { limit, offset });
  if (offset === 0 && !busy) store.capture(cwd, 'external-change').catch(e => console.error('Snapshot:', e.message));
  return response;
}
async function handle(req, res) {
  accessAllowed(req);
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/bootstrap') return send(res, 200, { token, recent: store.recents(), repo: active });
  if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, await currentState(url));
  if (req.method === 'GET' && url.pathname === '/api/reachable') {
    const cwd=requireActive(), selected=await validRef(cwd, url.searchParams.get('ref'));
    const output=await git(cwd,['rev-list','--max-count=30000',selected.sha],{maxBytes:2500000});
    return send(res,200,{ref:selected.fullName,shas:output.output.trim().split('\n').filter(Boolean),truncated:output.output.trim().split('\n').length>=30000});
  }
  if (req.method === 'GET' && url.pathname === '/api/stats') return send(res, 200, await analytics(requireActive(), Object.fromEntries(url.searchParams)));
  if (req.method === 'GET' && url.pathname === '/api/files') return send(res, 200, await fileActivity(requireActive(), Object.fromEntries(url.searchParams)));
  if (req.method === 'GET' && url.pathname === '/api/compare') return send(res, 200, await compare(requireActive(), url.searchParams.get('a'), url.searchParams.get('b')));
  if (req.method === 'GET' && url.pathname === '/api/commit') return send(res, 200, await commitDetail(requireActive(), url.searchParams.get('sha')));
  if (req.method === 'GET' && url.pathname === '/api/diff') return send(res, 200, await diff(requireActive(), url.searchParams.get('sha')));
  if (req.method === 'GET' && url.pathname === '/api/xray') return send(res, 200, await xray(requireActive(), url.searchParams.get('a'), url.searchParams.get('b')));
  if (req.method === 'GET' && url.pathname === '/api/snapshots') return send(res, 200, { items: store.list(requireActive()), operations: store.operations(requireActive()) });
  if (req.method === 'GET' && url.pathname === '/api/snapshot') return send(res, 200, await store.read(requireActive(), url.searchParams.get('id')));
  if (req.method === 'GET' && url.pathname === '/api/snapshot-diff') return send(res, 200, await store.compare(requireActive(), url.searchParams.get('from'), url.searchParams.get('to')));
  if (req.method === 'GET' && url.pathname === '/api/preview') return send(res, 200, await preview(requireActive(), url.searchParams.get('type'), Object.fromEntries(url.searchParams)));
  if (req.method === 'POST') {
    canWrite(req);
    const input = await parseBody(req);
    if (url.pathname === '/api/open') {
      if (busy) throw new GitError('Operation in progress', 409);
      active = await openRepo(input.path);
      store.markRecent(active);
      await store.capture(active, 'opened');
      return send(res, 200, await overview(active, { limit: 500 }));
    }
    if (url.pathname === '/api/operation') {
      const cwd = requireActive();
      if (busy) throw new GitError('Another Git operation is in progress', 409);
      busy = true;
      let result;
      try {
        const plan = await preview(cwd, input.type, input);
        await store.capture(cwd, `before:${plan.type}`);
        result = await execute(cwd, input.type, input);
        await store.capture(cwd, `after:${plan.type}`);
        store.record(cwd, input.type, { branch: input.branch, remote: input.remote }, result.ok ? 'success' : 'error', result.output);
      } catch (e) {
        store.record(cwd, input.type || 'unknown', { branch: input.branch, remote: input.remote }, 'error', e.message);
        throw e;
      } finally { busy = false; }
      return send(res, 200, result);
    }
  }
  if (req.method === 'GET' && allowedFiles.has(url.pathname)) {
    const file = resolve(root, allowedFiles.get(url.pathname));
    if (!file.startsWith(root + sep)) throw new GitError('Invalid static resource', 403);
    const buffer = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    return res.end(buffer);
  }
  return send(res, 404, { error: 'Unknown route' });
}
export function createAppServer() {
  return createServer((req, res) => handle(req, res).catch(e => fail(res, e)));
}
function launch(url) {
  if (process.env.GITSCOPE_NO_OPEN === '1' || process.env.CI) return;
  try {
    const platform = process.platform;
    const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
    const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {}); child.unref();
  } catch { /* Browser launch is best-effort; local server stays available. */ }
}
export async function start({ port = Number(process.env.PORT || 4173), noOpen = false } = {}) {
  await store.init();
  const server = createAppServer();
  await new Promise((ok, err) => server.once('error', err).listen(port, '127.0.0.1', ok));
  const address = `http://127.0.0.1:${server.address().port}`;
  console.log(`GitScope running at ${address}`);
  const timer = setInterval(async () => {
    if (!active || busy || polling) return;
    polling = true;
    try { await store.capture(active, 'external-change'); } catch (e) { console.error('Polling:', e.message); } finally { polling = false; }
  }, 15000);
  timer.unref();
  server.on('close', () => { clearInterval(timer); store.close(); });
  if (!noOpen) launch(address);
  return { server, store, address };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start().catch(e => { console.error(e); process.exitCode = 1; });
