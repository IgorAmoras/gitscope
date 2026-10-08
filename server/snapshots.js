import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { overview, log } from './git.js';

export class SnapshotStore {
  constructor(location = join(homedir(), '.gitscope')) { this.root = location; this.db = null; this.inflight = new Map(); }
  async init() {
    await mkdir(this.root, { recursive: true }); await mkdir(join(this.root, 'snapshots'), { recursive: true });
    this.db = new DatabaseSync(join(this.root, 'gitscope.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS recent (repo TEXT PRIMARY KEY, opened TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, repo TEXT NOT NULL, captured TEXT NOT NULL, fingerprint TEXT NOT NULL, summary TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshots_repo ON snapshots(repo, captured DESC);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, repo TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, params TEXT, result TEXT NOT NULL, message TEXT);`);
  }
  markRecent(repo) { this.db.prepare('INSERT INTO recent(repo,opened) VALUES(?,?) ON CONFLICT(repo) DO UPDATE SET opened=excluded.opened').run(repo, new Date().toISOString()); }
  recents() { return this.db.prepare('SELECT repo,opened FROM recent ORDER BY opened DESC LIMIT 12').all(); }
  list(repo) { return this.db.prepare('SELECT id,captured,summary,fingerprint FROM snapshots WHERE repo=? ORDER BY captured DESC LIMIT 500').all(repo).map(x => ({ ...x, summary: JSON.parse(x.summary) })); }
  async capture(repo, reason = 'observed') {
    const previous = this.inflight.get(repo) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.#captureUnlocked(repo, reason));
    this.inflight.set(repo, task);
    try { return await task; } finally { if (this.inflight.get(repo) === task) this.inflight.delete(repo); }
  }
  async #captureUnlocked(repo, reason) {
    const state = await overview(repo, { limit: 1 });
    const stable = JSON.stringify({ refs: state.refs.map(r => [r.fullName, r.sha]), sha: state.head.sha, branch: state.head.branch, dirty: state.head.dirty, changes: state.head.changes });
    const fingerprint = createHash('sha256').update(stable).digest('hex');
    const last = this.db.prepare('SELECT id,fingerprint FROM snapshots WHERE repo=? ORDER BY captured DESC LIMIT 1').get(repo);
    if (last?.fingerprint === fingerprint) return { id: last.id, changed: false };
    const id = randomUUID(), captured = new Date().toISOString();
    const commits = await log(repo, { limit: 2500 });
    const summary = { branch: state.head.branch, refs: state.refs.length, commits: state.total, cached: commits.length, reason };
    const record = { version: 1, id, captured, repo, reason, refs: state.refs, head: state.head, total: state.total, commits,
      complete: commits.length === state.total, disclaimer: 'A visual metadata snapshot; it is not a backup of Git objects or source files.' };
    const file = join(this.root, 'snapshots', `${id}.json.gz`);
    await writeFile(file, gzipSync(JSON.stringify(record)), { flag: 'wx' });
    this.db.prepare('INSERT INTO snapshots(id,repo,captured,fingerprint,summary) VALUES(?,?,?,?,?)').run(id, repo, captured, fingerprint, JSON.stringify(summary));
    return { id, changed: true, summary };
  }
  async read(repo, id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw Error('Invalid snapshot id');
    const item = this.db.prepare('SELECT id FROM snapshots WHERE id=? AND repo=?').get(id, repo);
    if (!item) throw Error('Snapshot not found');
    return JSON.parse(gunzipSync(await readFile(join(this.root, 'snapshots', `${id}.json.gz`))).toString('utf8'));
  }
  async compare(repo, first, second) {
    const [a, b] = await Promise.all([this.read(repo, first), this.read(repo, second)]);
    const A = new Map(a.refs.map(r => [r.fullName, r.sha])); const B = new Map(b.refs.map(r => [r.fullName, r.sha]));
    return { from: a.captured, to: b.captured,
      created: [...B.keys()].filter(k => !A.has(k)), deleted: [...A.keys()].filter(k => !B.has(k)),
      moved: [...B.entries()].filter(([k,v]) => A.has(k) && A.get(k) !== v).map(([ref,sha]) => ({ ref, from: A.get(ref), to: sha })),
      headChanged: a.head.sha !== b.head.sha || a.head.branch !== b.head.branch,
      note: 'This compares recorded refs at captured times; it does not prove how a change was made.' };
  }
  record(repo, type, params, result, message) {
    const id = randomUUID(); this.db.prepare('INSERT INTO operations(id,repo,at,type,params,result,message) VALUES(?,?,?,?,?,?,?)').run(id, repo, new Date().toISOString(), type, JSON.stringify(params), result, message || '');
    return id;
  }
  operations(repo) { return this.db.prepare('SELECT * FROM operations WHERE repo=? ORDER BY at DESC LIMIT 100').all(repo).map(x => ({...x,params: JSON.parse(x.params)})); }
  close() { this.db?.close(); }
}
