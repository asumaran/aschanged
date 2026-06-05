import * as vscode from "vscode";
import {
  commitTime,
  detectMainBranch,
  listBranches,
  mergeBase,
  revParse,
} from "./git";

/**
 * Resuelve y persiste el branch base contra el que se comparan los cambios.
 *
 * Jerarquía de resolución:
 *   1. Override manual por branch (workspaceState)  -> gana siempre, salvo
 *      que `alwaysCompareToMain` esté activo.
 *   2. Branch principal del repo (main/master/...).
 *
 * El "auto merge-base más cercano" NO es el default silencioso: se expone como
 * comando explícito que escribe un override manual.
 */
export class BaseResolver {
  constructor(private readonly memento: vscode.Memento) {}

  private key(repoRoot: string, branch: string): string {
    return `bcf.base::${repoRoot}::${branch}`;
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

  /** Override manual guardado para este branch, si existe. */
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
   * Devuelve el branch base efectivo para el branch actual.
   * `branch` puede ser null (detached HEAD): en ese caso no hay override
   * posible y se usa el branch principal.
   */
  async resolve(repoRoot: string, branch: string | null): Promise<string | null> {
    if (!this.alwaysMain && branch) {
      const override = this.getOverride(repoRoot, branch);
      if (override) return override;
    }
    return detectMainBranch(repoRoot, this.candidates());
  }

  /**
   * Heurística "merge-base más cercano": entre todos los branches candidatos,
   * elige aquel cuyo punto de divergencia con HEAD es el más reciente.
   * Excluye el branch actual y los descendientes de HEAD (cuyo merge-base es
   * el propio tip de HEAD), para no elegir un branch hijo.
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
      if (mb === headSha) continue; // cand es descendiente/igual a HEAD -> ignorar

      const when = await commitTime(repoRoot, mb);
      if (!best || when > best.when) {
        best = { branch: cand, when };
      }
    }

    return best?.branch ?? null;
  }
}
