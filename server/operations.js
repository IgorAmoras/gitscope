import { git, head, validRef, refs, GitError, compare } from './git.js';

const allowed = new Set(['fetch','pull','push','switch','create','delete','merge','rebase','merge-abort','rebase-abort','rebase-continue','merge-continue']);
const nameOk = x => typeof x === 'string' && x.length <= 160 && /^[a-zA-Z0-9][a-zA-Z0-9._/\-]*$/.test(x) && !x.includes('..') && !x.includes('@{') && !x.endsWith('.lock') && !x.startsWith('-');

export async function preview(cwd, type, options = {}) {
  if (!allowed.has(type)) throw new GitError('Unsupported operation');
  const h = await head(cwd);
  const param = options.branch || '';
  let target = null;
  if (['switch','merge','rebase','delete'].includes(type)) target = await validRef(cwd, param, type === 'switch' ? ['local'] : ['local']);
  if (type === 'create' && !nameOk(param)) throw new GitError('Invalid branch name');
  if (type === 'delete' && (param === h.branch || options.force)) throw new GitError('Cannot delete the checked-out branch or force-delete through GitScope');
  if (['rebase','merge','switch','pull'].includes(type) && h.dirty) throw new GitError('Working tree has changes. Commit or stash externally before this operation.');
  if (['merge','rebase'].includes(type) && h.detached) throw new GitError('Checkout a local branch before merging or rebasing');
  let remote = options.remote || 'origin';
  if (['fetch','pull','push'].includes(type)) {
    const remotes = (await git(cwd, ['remote'])).output.trim().split('\n').filter(Boolean);
    if (!remotes.includes(remote)) throw new GitError('Unknown remote. Configure a Git remote first.');
  }
  if (type === 'pull') {
    if (!h.branch) throw new GitError('Checkout a local branch with an upstream before pulling');
    const upstream=await git(cwd,['rev-parse','--abbrev-ref','--symbolic-full-name','@{upstream}'],{allowFailure:true});
    if(upstream.code !== 0 || !upstream.output.trim()) throw new GitError('This branch has no upstream. Configure upstream externally before pulling.');
    remote=upstream.output.trim();
  }
  if (type === 'push' && !h.branch) throw new GitError('Select a local branch before pushing');
  const targetName = target?.name || null;
  const summary = {
    fetch: `Fetch remote references from ${remote} (network request; no checkout change).`,
    pull: `Pull ${h.branch} from its tracked upstream ${remote} using fast-forward only. No implicit merge commit.`,
    push: `Push ${h.branch} to ${remote} without force.`,
    switch: `Switch to local branch ${targetName}.`,
    create: `Create branch ${param} from HEAD (without switching).`,
    delete: `Safely delete merged local branch ${targetName}; unmerged branches will be refused.`,
    merge: `Merge ${targetName} into ${h.branch}; Git may create a merge commit or report conflicts.`,
    rebase: `Rebase ${h.branch} onto ${targetName}. This rewrites local commits and can cause conflicts.`,
    'merge-abort': 'Abort the current merge attempt, restoring its pre-merge state.',
    'rebase-abort': 'Abort the current rebase attempt, restoring its pre-rebase state.',
    'merge-continue': 'Commit the resolved merge; only after conflicts have been resolved externally.',
    'rebase-continue': 'Continue the current rebase after resolving conflicts externally.'
  }[type];
  return { type, branch: targetName || param, remote, summary, destructive: ['delete','merge','rebase','rebase-abort','merge-abort'].includes(type), current: h.branch, dirty: h.dirty };
}
export async function execute(cwd, type, options = {}) {
  const plan = await preview(cwd, type, options);
  const args = {
    fetch: ['fetch', plan.remote],
    pull: ['pull', '--ff-only'],
    push: ['push', plan.remote, 'HEAD'],
    switch: ['switch', plan.branch],
    create: ['branch', plan.branch],
    delete: ['branch', '-d', plan.branch],
    merge: ['merge', '--no-edit', plan.branch],
    rebase: ['rebase', plan.branch],
    'merge-abort': ['merge', '--abort'],
    'rebase-abort': ['rebase', '--abort'],
    'merge-continue': ['commit', '--no-edit'],
    'rebase-continue': ['-c', 'core.editor=true', 'rebase', '--continue']
  }[type];
  const result = await git(cwd, args, { allowFailure: true, timeout: ['fetch','pull','push'].includes(type) ? 120000 : 90000, maxBytes: 2_000_000 });
  const after = await head(cwd);
  return { ok: result.code === 0, output: (result.output + '\n' + result.stderr).trim(), exitCode: result.code,
    conflicts: after.conflicts, mergeInProgress: after.mergeInProgress,
    current: after.branch,
    guidance: after.conflicts.length ? 'Resolve conflicts in your editor and stage the resolved files; then use Continue or Abort in GitScope.' : null };
}
