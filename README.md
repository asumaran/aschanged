# AS Changed

An Explorer section that lists the files changed in the current branch
**relative to its base branch**, distinguishing what's already committed from
what still has uncommitted changes.

## What it shows

- A **Branch Changes** view inside the Explorer.
- Two presentation modes, toggled with a button in the view's title bar (just
  like Source Control's list/tree toggle):
  - **Folder tree** (default): files nested by folder, like the Explorer's file
    section. Respects `explorer.compactFolders`.
  - **Flat list**: one node per file with the full relative path.
  - The chosen mode is remembered across sessions.
- In the header: `current_branch ← base` (with `(manual)` when the base is an override).
- Files with uncommitted changes get a git-style letter badge in the matching
  git theme color:
  - `M` modified · `A` added · `D` deleted · `R` renamed · `U` untracked.
  - Committed files get no badge: being part of the branch is the default here.
- Click a file → diff between the **base (merge-base)** and the working tree.
  Deleted files open the diff (there's nothing to open in the working tree).

## How the base is chosen

Hierarchy:

1. **Manual per-branch override** (*Pick base branch...* command), remembered
   per branch in the workspace.
2. The repo's **main branch**, preferring the **remote ref** (`origin/master`)
   over the local one (`master`), taken from `origin/HEAD` or the first
   `mainBranchCandidates` entry.

### Why `origin/master` and not `master`

GitHub/GitLab compute a PR's files with a **three-dot diff** (`base...head`),
whose merge-base is the divergence point against the **server's** master.
`origin/master` is the local mirror of that state; the local `master` is often
stale and, by pushing the merge-base backwards, drags in files from commits
unrelated to the branch (they appear as "extra").

That's why the comparison targets `origin/*`. For it to match the PR exactly,
`origin/master` must be up to date: use the **Fetch base branch** button (or
`git fetch`) if you see discrepancies.

The **closest merge-base** is an explicit button (*Auto-detect base branch*),
not a silent default: it handles stacked branches (`feature_x → feature_z`) and,
if you confirm, saves it as an override.

With `aschanged.alwaysCompareToMain: true`, overrides are ignored and the
comparison always runs against the main branch.

## Why it can't detect the base "on its own"

Git doesn't store which branch a branch was born from (a branch is just a
pointer to a commit). What it can do is compute the divergence point
(`merge-base`) against a given ref. So the base is a **choice** (manual or the
main branch), just like the "compare against" of clients such as Tower.

## Configuration

| Option | Default | Description |
|---|---|---|
| `aschanged.alwaysCompareToMain` | `false` | Always force the main branch. |
| `aschanged.mainBranchCandidates` | `["main","master","develop"]` | Default base candidates. |
| `aschanged.respectFilesExclude` | `true` | Hide files matching `files.exclude`. |

> `.gitignore` (node_modules, .env, etc.) is already filtered by git: those
> files don't appear in the diff or in the status. `files.exclude` applies on top.

## Development

```bash
npm install
npm run watch      # incremental build with esbuild
# F5 in VSCode -> "Run Extension"
```

## Limitations (v0.1)

- Uses the first workspace folder / repo. Multi-repo is a future improvement.
- Integrating with the GitHub/GitLab PR base is left for a later phase.
- **Pending** (uncommitted) files are shown even if they aren't in the server's
  PR: this is intentional, but it explains count differences with GitHub.
- `origin/<base>` is compared as-is locally; if you haven't fetched recently it
  may be stale. *Fetch base branch* updates it.
