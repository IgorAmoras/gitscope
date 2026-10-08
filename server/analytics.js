import { git, log, refs, validRef, head } from './git.js';

export async function analytics(cwd, { branch = '', author = '', days = 365 } = {}) {
  const selected = branch ? await validRef(cwd, branch) : null;
  days = Math.min(1825, Math.max(7, Number(days) || 365));
  const ref = selected?.sha || '--all';
  // Git CLI supplies unique reachable commits; reused SHAs are never double-counted.
  const commits = [];
  const page = 3000;
  for (let offset = 0; offset < 30000; offset += page) {
    const batch = await log(cwd, { ref, limit: page, offset });
    commits.push(...batch);
    if (batch.length < page) break;
  }
  const h = selected ? null : await head(cwd);
  const totalReachable = selected ? Number((await git(cwd, ['rev-list', '--count', selected.sha])).output.trim()) : Number((await git(cwd, h.sha?['rev-list', '--count', '--all','HEAD']:['rev-list','--count','--all'])).output.trim());
  const names = await refs(cwd);
  const allAuthors = [...new Map(commits.map(c => [c.email.toLowerCase(), { email: c.email, name: c.author }])).values()];
  const filtered = commits.filter(c => !author || c.email.toLowerCase() === author.toLowerCase());
  const now = Date.now(), cutoff = now - days * 86400000;
  const range = filtered.filter(c => c.authored * 1000 >= cutoff && c.authored * 1000 <= now + 86400000);
  const daysMap = Object.create(null), authorCounts = new Map(), monthsMap = Object.create(null);
  for (const c of range) {
    const day = new Date(c.authored * 1000).toISOString().slice(0, 10);
    daysMap[day] = (daysMap[day] || 0) + 1;
    const month = day.slice(0, 7); monthsMap[month] = (monthsMap[month] || 0) + 1;
    const key = c.email.toLowerCase();
    const cur = authorCounts.get(key) || { email: c.email, name: c.author, count: 0 };
    cur.count++; authorCounts.set(key, cur);
  }
  const recent7 = filtered.filter(c => c.authored * 1000 >= now - 7 * 86400000).length;
  const recent30 = filtered.filter(c => c.authored * 1000 >= now - 30 * 86400000).length;
  return {
    scope: { branch: selected?.name || null, author: author || null, days },
    total: filtered.length, totalReachable, sampled: totalReachable > commits.length,
    countLabel: selected ? 'Commits reachable from branch' : 'Unique commits reachable from all refs',
    contributors: new Set(filtered.map(c => c.email.toLowerCase())).size,
    branches: names.filter(x => x.kind === 'local').length,
    merges: filtered.filter(c => c.parents.length > 1).length,
    recent7, recent30,
    authors: allAuthors.sort((a,b) => a.name.localeCompare(b.name)),
    contributorsRanked: [...authorCounts.values()].sort((a, b) => b.count - a.count).slice(0, 20),
    daily: daysMap, monthly: monthsMap,
    note: 'Contribution dates use Git author timestamps in UTC. Local history and GitHub profile calendars can differ.'
  };
}

export async function fileActivity(cwd, { branch = '', author = '' } = {}) {
  const selected = branch ? await validRef(cwd, branch) : null;
  const args = ['log', '--max-count=450', '--numstat', '--format=%x00%H%x00%ae%x00', '-z'];
  args.push(selected?.sha || '--all');
  const raw = (await git(cwd, args, { maxBytes: 14_000_000, timeout: 45000 })).output;
  const chunks = raw.split('\0'); const fileMap = new Map(); let activeAuthor = '';
  for (let i = 0; i < chunks.length; i++) {
    const token = chunks[i];
    if (/^[0-9a-f]{40,64}$/.test(token)) { activeAuthor = chunks[i + 1] || ''; i++; continue; }
    if (author && activeAuthor.toLowerCase() !== author.toLowerCase()) continue;
    const match = token.trimStart().match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (!match) continue;
    const [_, plus, minus, filename] = match;
    if (!filename) continue;
    const item = fileMap.get(filename) || { file: filename, additions: 0, deletions: 0, touches: 0 };
    item.additions += Number(plus) || 0; item.deletions += Number(minus) || 0; item.touches++;
    fileMap.set(filename, item);
  }
  return { files: [...fileMap.values()].sort((a,b) => b.touches-a.touches).slice(0, 15), sampledCommits: 450, approximate: true };
}
