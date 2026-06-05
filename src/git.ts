import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

/** Whether the change is already committed in the branch or still pending. */
export type FileStatus = "committed" | "pending";

/** The kind of change git reports for a path (its M/A/D/R status). */
export type ChangeKind = "added" | "modified" | "deleted" | "renamed" | "untracked";

/** A path plus its raw change kind, as parsed from a single git command. */
export interface RawChange {
  /** Path relative to the repo root, with POSIX separators. */
  relPath: string;
  kind: ChangeKind;
}

export interface ChangedFile {
  /** Path relative to the repo root, with POSIX separators. */
  relPath: string;
  status: FileStatus;
  kind: ChangeKind;
}

/**
 * Runs git in `cwd` and returns stdout. Throws if the command fails.
 * High maxBuffer for large diffs.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pexecFile("git", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

/** Returns the root of the repo containing `cwd`, or null if there's no repo. */
export async function getRepoRoot(cwd: string): Promise<string | null> {
  try {
    const out = await git(cwd, ["rev-parse", "--show-toplevel"]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Current branch, or null when in detached HEAD. */
export async function getCurrentBranch(repoRoot: string): Promise<string | null> {
  try {
    const out = await git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return out.trim() || null;
  } catch {
    return null; // detached HEAD
  }
}

/** Lists local and remote branches (excluding the symbolic HEAD of remotes). */
export async function listBranches(repoRoot: string): Promise<string[]> {
  const out = await git(repoRoot, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
    "refs/remotes",
  ]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.endsWith("/HEAD"));
}

/** Checks whether a ref exists. */
export async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `git fetch <remote> <branch>` to update the remote-tracking ref
 * (e.g. `origin/master`). Throws if the remote doesn't respond.
 */
export async function fetchBranch(
  repoRoot: string,
  remote: string,
  branch: string
): Promise<void> {
  await git(repoRoot, ["fetch", "--quiet", remote, branch]);
}

/** SHA of a ref, or null. */
export async function revParse(repoRoot: string, ref: string): Promise<string | null> {
  try {
    const out = await git(repoRoot, ["rev-parse", "--verify", "--quiet", ref]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** merge-base between two refs, or null if they share no ancestor. */
export async function mergeBase(
  repoRoot: string,
  a: string,
  b: string
): Promise<string | null> {
  try {
    const out = await git(repoRoot, ["merge-base", a, b]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Commit timestamp (epoch) of a ref, or 0. */
export async function commitTime(repoRoot: string, ref: string): Promise<number> {
  try {
    const out = await git(repoRoot, ["show", "-s", "--format=%ct", ref]);
    return parseInt(out.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Default main branch of the repo. Tries origin's HEAD first, then the
 * provided candidates.
 *
 * Prefers the remote-tracking ref (`origin/master`) over the local one
 * (`master`): the server (GitHub/GitLab) computes the PR diff against ITS
 * master, and `origin/master` is the local mirror of that state. The local
 * `master` is often stale, which would push the merge-base backwards and drag
 * in files from commits unrelated to the branch. (Requires `git fetch` to keep
 * `origin/master` up to date.)
 */
export async function detectMainBranch(
  repoRoot: string,
  candidates: string[]
): Promise<string | null> {
  // origin/HEAD points to the remote default (e.g. origin/main). We keep the
  // `origin/` prefix so we compare against the remote ref.
  try {
    const out = await git(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    const ref = out.trim(); // "origin/main"
    if (ref) return ref;
  } catch {
    // no remote / no configured HEAD
  }

  for (const cand of candidates) {
    if (await refExists(repoRoot, `origin/${cand}`)) return `origin/${cand}`;
    if (await refExists(repoRoot, cand)) return cand;
  }
  return null;
}

/**
 * Files changed in the branch's commits since the base (merge-base).
 * Uses `git diff --name-status -z <mergeBase> HEAD`.
 */
export async function committedFiles(
  repoRoot: string,
  mergeBaseSha: string
): Promise<RawChange[]> {
  const out = await git(repoRoot, [
    "diff",
    "--name-status",
    "--diff-filter=ACMRTD",
    "-z",
    mergeBaseSha,
    "HEAD",
  ]);
  return parseNameStatusZ(out);
}

/**
 * Files with pending changes (staged + working tree + untracked).
 * Uses `git status --porcelain=v1 -z`.
 */
export async function pendingFiles(repoRoot: string): Promise<RawChange[]> {
  const out = await git(repoRoot, ["status", "--porcelain=v1", "-z"]);
  return parsePorcelainZ(out);
}

/** Maps a `--name-status` single-letter code to a normalized change kind. */
function nameStatusKind(code: string): ChangeKind {
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "added"; // a copy lands as a new file
    default:
      return "modified"; // M, T (type change)
  }
}

/** Parser for `--name-status -z`: handles renames (R/C status carry two paths). */
function parseNameStatusZ(out: string): RawChange[] {
  const tokens = out.split("\0");
  const changes: RawChange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (!status) continue;
    const code = status[0];
    if (code === "R" || code === "C") {
      // status \0 oldPath \0 newPath
      const newPath = tokens[i + 2];
      if (newPath) changes.push({ relPath: newPath, kind: nameStatusKind(code) });
      i += 2;
    } else {
      // status \0 path
      const p = tokens[i + 1];
      if (p) changes.push({ relPath: p, kind: nameStatusKind(code) });
      i += 1;
    }
  }
  return changes;
}

/** Maps the porcelain XY status pair to a normalized change kind. */
function porcelainKind(xy: string): ChangeKind {
  const x = xy[0];
  const y = xy[1];
  if (x === "?" || y === "?") return "untracked";
  if (x === "D" || y === "D") return "deleted";
  if (x === "R" || y === "R") return "renamed";
  if (x === "C") return "added";
  if (x === "A" || y === "A") return "added";
  return "modified";
}

/** Parser for `status --porcelain=v1 -z`: returns paths with their change kind. */
function parsePorcelainZ(out: string): RawChange[] {
  const tokens = out.split("\0");
  const changes: RawChange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3); // skip "XY "
    if (path) changes.push({ relPath: path, kind: porcelainKind(xy) });
    // Renames/copies: the source path comes in the next token.
    if (xy[0] === "R" || xy[0] === "C") {
      i += 1;
    }
  }
  return changes;
}
