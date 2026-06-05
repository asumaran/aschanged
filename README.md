# AS Changed

An Explorer section listing the files changed in the current branch **relative
to its base branch**, distinguishing committed from uncommitted changes.

## What it shows

- A **Branch Changes** view in the Explorer, with a **tree / flat-list** toggle
  in the title bar (tree respects `explorer.compactFolders`). The mode is remembered.
- Header: `current_branch ← base` (`(manual)` when the base is an override).
- Uncommitted files get a git-style letter badge in the matching color
  (`M` modified · `A` added · `D` deleted · `R` renamed · `U` untracked).
  Committed files get no badge.
- Click a file → diff between the **base (merge-base)** and the working tree.

## The base branch

The base is a **choice**, not something git stores. Resolution order:

1. **Manual per-branch override** (*Pick base branch...*), or *Auto-detect base
   branch* for stacked branches.
2. The repo's **main branch**, preferring the remote ref (`origin/master`) over
   the local one.

It compares against `origin/*` because that mirrors the server's state (same as
a PR's three-dot diff). If `origin/<base>` is stale you may see extra files —
use **Fetch base branch** to update it.

## Configuration

| Option | Default | Description |
|---|---|---|
| `aschanged.alwaysCompareToMain` | `false` | Always force the main branch. |
| `aschanged.mainBranchCandidates` | `["main","master","develop"]` | Default base candidates. |
| `aschanged.respectFilesExclude` | `true` | Hide files matching `files.exclude`. |

## Development

```bash
npm install
npm run watch   # then F5 in VSCode -> "Run Extension"
```
