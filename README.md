# GitScope

**History, illuminated.** A local-first desktop-browser Git explorer focused on a precise, interactive commit DAG inspired by GitKraken. No Electron, React, account, cloud dependency, or external telemetry.

## Requirements

- **Node.js 22.13+** (the bundled SQLite API in Node 22 is still experimental and may print a warning).
- **Git CLI** installed on your `PATH`.
- Modern desktop browser. Windows is the priority; Linux and macOS are also supported.

## Run

```bash
git clone https://github.com/IgorAmoras/gitscope.git
cd gitscope
npm start
```

The app listens on **http://127.0.0.1:4173** and attempts to open a browser. To run on another port, set `PORT`; to suppress opening the browser, set `GITSCOPE_NO_OPEN=1`. Dependencies are entirely built-in; `npm install` is not needed. Run `npm test` for Git-backed tests or `npm run dev` for local development.

1. Paste an **absolute path** to a local Git working tree, including paths with spaces.
2. GitScope loads references and a topologically ordered commit graph automatically.
3. Click a branch to focus its reachable ancestry, or **Ctrl-click** a second branch to compare its history. Right-click a branch for Git actions and favorites.
4. Click a commit to select it and double-click to inspect details. Press `/` to search; `Esc` closes the inspector.
5. Open **Analytics**, **X-Ray**, or **Time Machine** from the top bar. Open **Git actions** to preview and run an operation.

## Features

- **Native DAG:** parent-accurate SVG commit graph, lanes, merges, colored references, author/date/SHA columns, incremental pagination and virtualized rows. The date column does not reorder history into an invalid topology.
- **Branch Intelligence:** merge-base, exact ahead/behind counts, exclusive SHA lists and deterministic explanations using native Git.
- **Analytics:** unique reachable commits, authors (matched by email), merge counts, 7/30-day activity, GitHub-style contribution heatmap, and sampled file churn. Filters for author, branch and period.
- **X-Ray:** recent local reflog events and equivalent-patch signals using `git cherry`. Equivalence **does not prove** cherry-pick or rebase.
- **Time Machine:** SQLite metadata index and compressed JSON graph snapshots in `~/.gitscope`, captured on open, after relevant changes and before/after operations. Scrub recorded snapshots in the **same graph**, and compare any two recorded states for ref creation/deletion/movements.
- **Git operations:** fetch, pull (`--ff-only`), push (no force), switch, branch create/delete (safe `-d`), merge, rebase and continue/abort flows. Explicit two-step preview; no conflict editor.
- **Local security:** loopback-only server, Origin and Host checks, in-memory random session token on JSON POST, allowlisted Git commands, bounded output and timeouts, no account tokens or credentials retained.

## Snapshot and data accuracy

Snapshots retain **graph metadata for up to the first 2,500 commits**, all discovered reference tips, and HEAD/dirty state; they are not backups of file contents or unreachable objects. Larger repositories show the captured portion and disclose truncation. Snapshots can show recorded metadata even after Git garbage collection, but cannot restore vanished source files. The Time Machine starts recording **when GitScope first sees a repository**. It cannot recover a complete timeline retroactively.

Analytics reads at most **30,000** reachable commits per scope, and file activity samples the most recent **450** commits; capped results are explicitly labeled. Dates use Git author timestamps in UTC, not GitHub's profile attribution rules. Multiple identities using different emails are separate contributors. Remote refs are fetched **only if you explicitly run fetch**. Authentication is delegated to your installed Git credential helper (noninteractive in the server).

## Git operation safeguards

A two-step preview is required for Git mutations. Dirty working trees block switch/merge/rebase/pull by default; `pull --ff-only` avoids implicit merge commits. Delete uses Git `-d` and never `-D`. Force push, reset, automatic conflict resolution and automatic external network polling are intentionally absent. If a merge or rebase stops on a conflict, resolve and stage files in your editor and use Continue or Abort; do not assume an operation completed merely because it was initiated. Ref and result logs are stored locally.

This tool can modify selected repositories **only after you invoke a Git action**. Simply opening a repo does not fetch, push, reset, or change `.git` to take snapshots.

## Known limitations / roadmap

- Commit graph uses a bounded in-memory page plus viewport DOM virtualization; extreme branch density may cause horizontal scrolling. Very large histories need further profiling and optimized layout.
- Historic snapshots contain a 2,500-commit window, not the complete metadata of an arbitrarily large graph. There is no automatic replay animation or date-by-date inferred reconstruction.
- X-Ray does not yet include full `git range-diff` alignment or a confidence-scored rebase mapping; reflog and patch-equivalence are read-only hints.
- No interactive conflict editor, working tree diff viewer, Git remote configuration UI, author-alias management UI, or filesystem picker (paste a path).
- Live auto refresh watches recorded refs approximately every 15 seconds and is not a file-system event watcher.
- Browser UI has not been validated across all screen sizes or Git histories; regression tests target Git data and endpoint behavior.

## Tests

```bash
npm test
npm run check
```

Tests create **temporary repositories**, including merges, branches, detached heads, cherry-picks, conflicts, snapshots, no-commit histories and local API security checks. They never mutate existing work repositories.

## Architecture

```text
server/git.js          Git subprocesses, parsed graph and reference intelligence
server/analytics.js    Git-backed statistics and file activity
server/snapshots.js    Native SQLite index + gzip-JSON graph metadata
server/operations.js   Strict safe operation preparation + execution
server/index.js        Loopback HTTP and JSON API
public/js/graph.js     Deterministic graph lane layout and virtual SVG viewport
public/js/app.js       Vanilla JS state, operations, panels and interactions
public/css/style.css  Dark visual design system
public/index.html      Application shell
```

The local data directory can be overridden with `GITSCOPE_DATA_DIR`. No npm runtime dependencies.
