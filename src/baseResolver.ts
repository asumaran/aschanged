import * as vscode from "vscode";
import {
  commitTime,
  detectMainBranch,
  listBranches,
  mergeBase,
  revParse,
} from "./git";

/**
 * Resolves and persists the base branch the changes are compared against.
 *
 * Resolution hierarchy:
 *   1. Manual per-branch override (workspaceState) -> always wins, unless
 *      `alwaysCompareToMain` is enabled.
 *   2. The repo's main branch (main/master/...).
 *
 * The "closest merge-base auto-detect" is NOT the silent default: it's exposed
 * as an explicit command that writes a manual override.
 */
export class BaseResolver {
  constructor(private readonly memento: vscode.Memento) {}

  private key(repoRoot: string, branch: string): string {
    return `aschanged.base::${repoRoot}::${branch}`;
  }

  private candidates(): string[] {
    return vscode.workspace
      .getConfiguration("aschanged")
      .get<string[]>("mainBranchCandidates", ["main", "master", "develop"]);
  }

  private get alwaysMain(): boolean {
    return vscode.workspace
      .getConfiguration("aschanged")
      .get<boolean>("alwaysCompareToMain", false);
  }

  /** Manual override saved for this branch, if any. */
  getOverride(repoRoot: string, branch: string): string | undefined {
    return this.memento.get<string>(this.key(repoRoot, branch));
  }

  async setOverride(repoRoot: string, branch: string, base: string): Promise<void> {
    await this.memento.update(this.key(repoRoot, branch), base);
  }

  async clearOverride(repoRoot: string, branch: string): Promise<void> {
    await this.memento.update(this.key(repoRoot, branch), undefined);
  }

  /**
   * Returns the effective base branch for the current branch.
   * `branch` may be null (detached HEAD): in that case there's no possible
   * override and the main branch is used.
   */
  async resolve(repoRoot: string, branch: string | null): Promise<string | null> {
    if (!this.alwaysMain && branch) {
      const override = this.getOverride(repoRoot, branch);
      if (override) return override;
    }
    return detectMainBranch(repoRoot, this.candidates());
  }

  /**
   * "Closest merge-base" heuristic: among all candidate branches, picks the one
   * whose divergence point with HEAD is the most recent. Excludes the current
   * branch and descendants of HEAD (whose merge-base is HEAD's own tip), so it
   * doesn't pick a child branch.
   */
  async autoDetect(repoRoot: string, currentBranch: string | null): Promise<string | null> {
    const headSha = await revParse(repoRoot, "HEAD");
    if (!headSha) return null;

    const branches = await listBranches(repoRoot);
    let best: { branch: string; when: number } | null = null;

    for (const cand of branches) {
      if (currentBranch && (cand === currentBranch || cand === `origin/${currentBranch}`)) {
        continue;
      }
      const mb = await mergeBase(repoRoot, cand, "HEAD");
      if (!mb) continue;
      if (mb === headSha) continue; // cand is a descendant of / equal to HEAD -> ignore

      const when = await commitTime(repoRoot, mb);
      if (!best || when > best.when) {
        best = { branch: cand, when };
      }
    }

    return best?.branch ?? null;
  }
}
