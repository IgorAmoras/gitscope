import { spawn } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import { stat, realpath } from 'node:fs/promises';

export class GitError extends Error {
  constructor(message, code = 400, stderr = '') {
    super(message); this.name = 'GitError'; this.status = code; this.stderr = stderr;
  }
}

export async function git(cwd, args, options = {}) {
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new GitError('Invalid Git arguments');
  const maxBytes = options.maxBytes ?? 24 * 1024 * 1024;
  return new Promise((done, reject) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', '--no-optional-locks', ...args], {
      cwd, windowsHide: true, shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...options.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const out = [], errors = []; let outSize = 0, errSize = 0, settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else done(result); };
    const timer = setTimeout(() => { child.kill(); finish(new GitError('Git operation timed out', 504)); }, options.timeout ?? 25000);
    child.stdout.on('data', b => { outSize += b.length; if (outSize > maxBytes) { child.kill(); finish(new GitError('Git output exceeded safe limit', 413)); } else out.push(b); });
    child.stderr.on('data', b => { errSize += b.length; if (errSize < 256 * 1024) errors.push(b); });
    child.on('error', e => finish(new GitError(e.code === 'ENOENT' ? 'Git is not installed or not on PATH' : e.message, 500)));
    child.on('close', code => {
      const output = Buffer.concat(out).toString('utf8'), stderr = Buffer.concat(errors).toString('utf8').trim();
      if (code !== 0 && !options.allowFailure) finish(new GitError(stderr || `Git exited with code ${code}`, 400, stderr));
      else finish(null, { output, stderr, code });
    });
  });
}

export async function openRepo(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048 || !isAbsolute(input)) throw new GitError('Enter an absolute filesystem path');
  let location;
  try {
    location = await realpath(resolve(input));
    if (!(await stat(location)).isDirectory()) throw Error('not a directory');
  } catch { throw new GitError('That directory does not exist or cannot be accessed', 404); }
  const { output } = await git(location, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (!output.trim()) throw new GitError('The selected folder is not inside a non-bare Git repository');
  return realpath(output.trim());
}

const META_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%B%x00';
export function parseLog(output) {
  const fields = output.split('\0'); const commits = [];
  for (let i = 0; i + 6 < fields.length;) {
    if (!/^[0-9a-f]{40,64}$/.test(fields[i])) { i++; continue; }
    const [sha, rawParents, author, email, authored, committed, body] = fields.slice(i, i + 7);
    i += 7;
    commits.push({ sha, parents: rawParents ? rawParents.split(' ') : [], author, email, authored: Number(authored), committed: Number(committed), subject: body.split('\n')[0], body: body.trimEnd() });
  }
  return commits;
}
export async function log(cwd, { limit = 500, offset = 0, ref = '--all' } = {}) {
  const count = Math.min(20000, Math.max(1, Number(limit) || 500));
  const skip = Math.max(0, Number(offset) || 0);
  // Git's topo-order is authoritative; timestamps are display metadata only.
  const args = ['log', '--topo-order', '-z', `--format=${META_FORMAT}`, `--max-count=${count}`, `--skip=${skip}`];
  if (ref === '--all') args.push('--all'); else args.push(ref);
  const { output, code } = await git(cwd, args, { allowFailure: true, timeout: 40000, maxBytes: 50 * 1024 * 1024 });
  if (code !== 0 && !/does not have any commits yet|your current branch .* does not have any commits/i.test(output)) return [];
  return parseLog(output);
}

export async function refs(cwd) {
  const format = '%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)%00';
  const raw = (await git(cwd, ['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes', 'refs/tags'])).output;
  const chunks = raw.split('\n').map(line => line.split('\0')).filter(v => v[0]);
  return chunks.map(([name, sha, upstream, head]) => ({
    name: name.replace(/^refs\/(heads|remotes|tags)\//, ''), fullName: name, sha, upstream,
    kind: name.startsWith('refs/heads/') ? 'local' : name.startsWith('refs/remotes/') ? 'remote' : 'tag', current: head === '*'
  }));
}
export async function head(cwd) {
  const sha = (await git(cwd, ['rev-parse', 'HEAD'], { allowFailure: true })).output.trim();
  const branch = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true })).output.trim();
  const status = (await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { timeout: 20000 })).output;
  const conflicts = (await git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'], { allowFailure: true })).output.split('\0').filter(Boolean);
  const rebase = (await git(cwd, ['rev-parse', '--git-path', 'rebase-merge'], { allowFailure: true })).output.trim();
  const mergeHead = (await git(cwd, ['rev-parse', '--verify', '-q', 'MERGE_HEAD'], { allowFailure: true })).output.trim();
  const shallow = (await git(cwd, ['rev-parse', '--is-shallow-repository'], { allowFailure: true })).output.trim() === 'true';
  return { sha: /^[a-f0-9]{40,64}$/.test(sha) ? sha : null, branch: branch || null, detached: !branch && !!sha, dirty: !!status, changes: status.split('\0').filter(Boolean).length, conflicts, mergeInProgress: !!mergeHead, rebasePotential: rebase, shallow };
}
export async function overview(cwd, { limit = 600, offset = 0 } = {}) {
  const [branches, status, commits, count] = await Promise.all([
    refs(cwd), head(cwd), log(cwd, { limit, offset }),
    git(cwd, ['rev-list', '--count', '--all'], { allowFailure: true })
  ]);
  return { repo: cwd, name: cwd.split(/[\\/]/).filter(Boolean).at(-1), refs: branches, head: status, commits, total: Number(count.output.trim()) || 0, offset, hasMore: offset + commits.length < (Number(count.output.trim()) || 0) };
}

export function assertSha(sha) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40,64}$/.test(sha)) throw new GitError('Invalid commit SHA');
  return sha;
}
export async function validRef(cwd, name, kinds = ['local', 'remote', 'tag']) {
  const available = await refs(cwd);
  const found = available.find(r => r.fullName === name || r.name === name && kinds.includes(r.kind));
  if (!found || !kinds.includes(found.kind)) throw new GitError('Unknown Git reference');
  return found;
}
export async function compare(cwd, a, b) {
  const A = await validRef(cwd, a), B = await validRef(cwd, b);
  const { output } = await git(cwd, ['rev-list', '--left-right', '--count', `${A.sha}...${B.sha}`]);
  const [left, right] = output.trim().split(/\s+/).map(Number);
  const base = (await git(cwd, ['merge-base', A.sha, B.sha], { allowFailure: true })).output.trim() || null;
  const status = left === 0 && right === 0 ? 'aligned' : !left ? 'fast-forward A → B' : !right ? 'fast-forward B → A' : 'diverged';
  const uniqueA = (await git(cwd, ['rev-list', '--max-count=300', A.sha, `^${B.sha}`])).output.trim().split('\n').filter(Boolean);
  const uniqueB = (await git(cwd, ['rev-list', '--max-count=300', B.sha, `^${A.sha}`])).output.trim().split('\n').filter(Boolean);
  return { a: A, b: B, aheadA: left, aheadB: right, mergeBase: base, status, uniqueA, uniqueB,
    truncated: left > 300 || right > 300,
    explanation: left === 0 && right === 0 ? 'These references point to equivalent histories.' :
      !left ? `${B.name} contains all commits reachable from ${A.name}.` :
      !right ? `${A.name} contains all commits reachable from ${B.name}.` :
      `${A.name} has ${left} unique commits; ${B.name} has ${right} unique commits.` };
}
export async function commitDetail(cwd, sha) {
  sha = assertSha(sha);
  const { output } = await git(cwd, ['show', '-s', `--format=${META_FORMAT}`, sha]);
  const commit = parseLog(output)[0];
  if (!commit) throw new GitError('Commit no longer available', 404);
  const included = (await git(cwd, ['branch', '-a', '--contains', sha, '--format=%(refname:short)'], { allowFailure: true })).output.trim().split('\n').filter(Boolean);
  const stat = (await git(cwd, ['show', '--format=', '--stat', '--no-renames', sha], { maxBytes: 900000 })).output;
  return { ...commit, branches: included, stat };
}
export async function diff(cwd, sha) {
  sha = assertSha(sha);
  // Explicitly anchor on a verified object and keep diff output bounded.
  const result = await git(cwd, ['show', '--format=', '--no-ext-diff', '--no-textconv', '--find-renames', sha], { maxBytes: 2_000_000, timeout: 30000 });
  return { sha, content: result.output, truncated: Buffer.byteLength(result.output) > 1_800_000 };
}
export async function xray(cwd, a, b) {
  const reflog = (await git(cwd, ['reflog', '--all', '--date=iso', '--format=%H%x09%gd%x09%gs', '-n', '150'], { allowFailure: true })).output.trim().split('\n').filter(Boolean).map(line => {
    const [sha, ref, ...msg] = line.split('\t'); return { sha, ref, message: msg.join('\t') };
  });
  let equivalent = [];
  if (a && b) {
    const A = await validRef(cwd, a), B = await validRef(cwd, b);
    const cherry = (await git(cwd, ['cherry', A.sha, B.sha], { allowFailure: true })).output.trim().split('\n').filter(Boolean);
    equivalent = cherry.filter(line => line.startsWith('- ')).slice(0, 100).map(line => ({ sha: line.slice(2), description: 'Equivalent patch detected (not proof of cherry-pick or rebase)' }));
  }
  return { reflog, equivalent, notes: ['Reflogs are local, expire over time, and may be unavailable.', 'Patch equivalence is evidence of similar changes, not proof of the operation performed.'] };
}
