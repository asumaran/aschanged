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
 * Ejecuta git en `cwd` y devuelve stdout. Lanza si el comando falla.
 * maxBuffer alto para diffs grandes.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pexecFile("git", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

/** Devuelve el root del repo que contiene `cwd`, o null si no hay repo. */
export async function getRepoRoot(cwd: string): Promise<string | null> {
  try {
    const out = await git(cwd, ["rev-parse", "--show-toplevel"]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Branch actual, o null si está en detached HEAD. */
export async function getCurrentBranch(repoRoot: string): Promise<string | null> {
  try {
    const out = await git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return out.trim() || null;
  } catch {
    return null; // detached HEAD
  }
}

/** Lista branches locales y remotos (sin el HEAD simbólico de remotos). */
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

/** Verifica si una ref existe. */
export async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hace `git fetch <remote> <branch>` para actualizar la ref de seguimiento
 * remota (p.ej. `origin/master`). Lanza si el remoto no responde.
 */
export async function fetchBranch(
  repoRoot: string,
  remote: string,
  branch: string
): Promise<void> {
  await git(repoRoot, ["fetch", "--quiet", remote, branch]);
}

/** SHA de una ref, o null. */
export async function revParse(repoRoot: string, ref: string): Promise<string | null> {
  try {
    const out = await git(repoRoot, ["rev-parse", "--verify", "--quiet", ref]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** merge-base entre dos refs, o null si no comparten ancestro. */
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

/** Timestamp (epoch) del commit de una ref, o 0. */
export async function commitTime(repoRoot: string, ref: string): Promise<number> {
  try {
    const out = await git(repoRoot, ["show", "-s", "--format=%ct", ref]);
    return parseInt(out.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Branch principal por defecto del repo. Intenta el HEAD de origin y luego
 * los candidatos provistos.
 *
 * Prefiere la ref de seguimiento remota (`origin/master`) por sobre la local
 * (`master`): el servidor (GitHub/GitLab) calcula el diff del PR contra SU
 * master, y `origin/master` es el espejo local de ese estado. El `master`
 * local suele estar desactualizado, lo que correría el merge-base hacia atrás
 * y arrastraría archivos de commits ajenos al branch. (Requiere `git fetch`
 * para que `origin/master` esté al día.)
 */
export async function detectMainBranch(
  repoRoot: string,
  candidates: string[]
): Promise<string | null> {
  // origin/HEAD apunta al default del remoto (p.ej. origin/main). Conservamos
  // el prefijo `origin/` para comparar contra la ref remota.
  try {
    const out = await git(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    const ref = out.trim(); // "origin/main"
    if (ref) return ref;
  } catch {
    // sin remoto / sin HEAD configurado
  }

  for (const cand of candidates) {
    if (await refExists(repoRoot, `origin/${cand}`)) return `origin/${cand}`;
    if (await refExists(repoRoot, cand)) return cand;
  }
  return null;
}

/**
 * Archivos cambiados en los commits del branch desde la base (merge-base).
 * Usa `git diff --name-status -z <mergeBase> HEAD`.
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
 * Archivos con cambios pendientes (staged + working tree + untracked).
 * Usa `git status --porcelain=v1 -z`.
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

/** Parser de `--name-status -z`: maneja renames (status R/C llevan dos paths). */
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

/** Parser de `status --porcelain=v1 -z`: devuelve los paths con su tipo de cambio. */
function parsePorcelainZ(out: string): RawChange[] {
  const tokens = out.split("\0");
  const changes: RawChange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3); // salta "XY "
    if (path) changes.push({ relPath: path, kind: porcelainKind(xy) });
    // Renames/copies: el path de origen viene en el siguiente token.
    if (xy[0] === "R" || xy[0] === "C") {
      i += 1;
    }
  }
  return changes;
}
