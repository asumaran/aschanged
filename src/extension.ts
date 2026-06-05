import * as vscode from "vscode";
import { minimatch } from "minimatch";
import {
  ChangedFile,
  committedFiles,
  fetchBranch,
  getCurrentBranch,
  getRepoRoot,
  listBranches,
  mergeBase,
  pendingFiles,
} from "./git";
import { BaseResolver } from "./baseResolver";
import {
  buildNodes,
  ChangedFileItem,
  ChangedFilesProvider,
  StatusDecorationProvider,
  TreeNode,
  ViewMode,
} from "./treeProvider";

interface RepoContext {
  repoRoot: string;
  branch: string | null;
  base: string | null;
  mergeBaseSha: string | null;
}

let provider: ChangedFilesProvider;
let decorations: StatusDecorationProvider;
let resolver: BaseResolver;
let treeView: vscode.TreeView<TreeNode>;
let current: RepoContext | null = null;
let refreshTimer: NodeJS.Timeout | undefined;
let viewMode: ViewMode = "tree";
let globalState: vscode.Memento;

const VIEW_MODE_KEY = "branchChangedFiles.viewMode";

export function activate(context: vscode.ExtensionContext) {
  provider = new ChangedFilesProvider();
  decorations = new StatusDecorationProvider();
  resolver = new BaseResolver(context.workspaceState);
  globalState = context.globalState;

  viewMode = globalState.get<ViewMode>(VIEW_MODE_KEY, "tree");
  void vscode.commands.executeCommand("setContext", VIEW_MODE_KEY, viewMode);

  treeView = vscode.window.createTreeView("branchChangedFiles.view", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    treeView,
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.commands.registerCommand("branchChangedFiles.refresh", () => refresh()),
    vscode.commands.registerCommand("branchChangedFiles.setBase", () => setBaseCommand()),
    vscode.commands.registerCommand("branchChangedFiles.autoDetectBase", () =>
      autoDetectCommand()
    ),
    vscode.commands.registerCommand("branchChangedFiles.clearBase", () => clearBaseCommand()),
    vscode.commands.registerCommand("branchChangedFiles.openDiff", (item: ChangedFileItem) =>
      openDiff(item)
    ),
    vscode.commands.registerCommand("branchChangedFiles.viewAsTree", () => setViewMode("tree")),
    vscode.commands.registerCommand("branchChangedFiles.viewAsList", () => setViewMode("list")),
    vscode.commands.registerCommand("branchChangedFiles.fetchBase", () => fetchBaseCommand())
  );

  // Refrescos reactivos.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => scheduleRefresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleRefresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("branchChangedFiles") ||
        e.affectsConfiguration("explorer.compactFolders")
      ) {
        scheduleRefresh();
      }
    })
  );

  // Eventos del git incorporado (commit, checkout, staging...).
  wireGitExtension(context);

  refresh();
}

export function deactivate() {
  if (refreshTimer) clearTimeout(refreshTimer);
}

/** Conecta a la API del git incorporado para escuchar cambios de estado. */
function wireGitExtension(context: vscode.ExtensionContext) {
  const ext = vscode.extensions.getExtension<any>("vscode.git");
  if (!ext) return;

  const hook = () => {
    try {
      const api = ext.exports.getAPI(1);
      const subscribe = (repo: any) =>
        context.subscriptions.push(repo.state.onDidChange(() => scheduleRefresh()));
      api.repositories.forEach(subscribe);
      context.subscriptions.push(api.onDidOpenRepository(subscribe));
    } catch {
      // API no disponible; quedan los demás triggers (save, comando manual).
    }
  };

  if (ext.isActive) hook();
  else ext.activate().then(hook, () => undefined);
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh(), 250);
}

/** Cambia entre vista de lista plana y vista de árbol de carpetas. */
async function setViewMode(mode: ViewMode): Promise<void> {
  if (viewMode === mode) return;
  viewMode = mode;
  await globalState.update(VIEW_MODE_KEY, mode);
  await vscode.commands.executeCommand("setContext", VIEW_MODE_KEY, mode);
  await refresh();
}

/** Recalcula todo el estado y repinta la vista. */
async function refresh(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    current = null;
    provider.setRoots([]);
    treeView.message = "Abrí una carpeta con un repositorio git.";
    return;
  }

  const repoRoot = await getRepoRoot(folder.uri.fsPath);
  if (!repoRoot) {
    current = null;
    provider.setRoots([]);
    treeView.message = "No se detectó un repositorio git en el workspace.";
    return;
  }

  const branch = await getCurrentBranch(repoRoot);
  const base = await resolver.resolve(repoRoot, branch);

  if (!base) {
    current = { repoRoot, branch, base: null, mergeBaseSha: null };
    provider.setRoots([]);
    decorations.update(repoRoot, []);
    treeView.message =
      "No se pudo determinar un branch base. Usá 'Elegir branch base...' o configurá mainBranchCandidates.";
    return;
  }

  const mb = await mergeBase(repoRoot, base, "HEAD");
  if (!mb) {
    current = { repoRoot, branch, base, mergeBaseSha: null };
    provider.setRoots([]);
    decorations.update(repoRoot, []);
    treeView.message = `El branch actual no comparte historia con '${base}'.`;
    return;
  }

  current = { repoRoot, branch, base, mergeBaseSha: mb };

  const [committed, pending] = await Promise.all([
    committedFiles(repoRoot, mb),
    pendingFiles(repoRoot),
  ]);

  const files = buildFileList(committed, pending);
  const visible = applyExcludes(files);

  // Header: branch actual + base + origen de la base.
  const overridden = branch ? !!resolver.getOverride(repoRoot, branch) : false;
  treeView.description = `${branch ?? "(detached)"} ← ${base}${overridden ? " (manual)" : ""}`;
  treeView.message = visible.length === 0 ? "Sin archivos modificados respecto a la base." : undefined;

  decorations.update(repoRoot, visible);

  const compactFolders = vscode.workspace
    .getConfiguration("explorer")
    .get<boolean>("compactFolders", true);
  provider.setRoots(buildNodes(visible, repoRoot, mb, viewMode, compactFolders));
}

/**
 * Une commiteados y pendientes en una sola lista. Si un archivo está en ambos,
 * gana "pending" (tiene cambios sin commitear).
 */
function buildFileList(committed: string[], pending: string[]): ChangedFile[] {
  const map = new Map<string, ChangedFile>();

  for (const relPath of committed) {
    map.set(relPath, { relPath, status: "committed" });
  }
  // Si un archivo también tiene cambios sin commitear, "pending" sobrescribe.
  for (const relPath of pending) {
    map.set(relPath, { relPath, status: "pending" });
  }

  return [...map.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/** Filtra archivos que coinciden con los globs de files.exclude. */
function applyExcludes(files: ChangedFile[]): ChangedFile[] {
  const respect = vscode.workspace
    .getConfiguration("branchChangedFiles")
    .get<boolean>("respectFilesExclude", true);
  if (!respect) return files;

  const exclude = vscode.workspace.getConfiguration("files").get<Record<string, boolean>>("exclude", {});
  const patterns = Object.entries(exclude)
    .filter(([, enabled]) => enabled)
    .map(([glob]) => glob);
  if (patterns.length === 0) return files;

  return files.filter((f) => !patterns.some((p) => matchesGlob(f.relPath, p)));
}

/** Coincidencia estilo VSCode: prueba el path y cada segmento de carpeta. */
function matchesGlob(relPath: string, pattern: string): boolean {
  const opts = { dot: true, nocase: process.platform === "darwin" || process.platform === "win32" };
  if (minimatch(relPath, pattern, opts)) return true;
  // files.exclude usa patrones tipo "**/node_modules" que deben atrapar también
  // archivos dentro de esa carpeta.
  return minimatch(relPath, `${pattern}/**`, opts);
}

// ---------- Comandos ----------

async function setBaseCommand(): Promise<void> {
  if (!current) return;
  const { repoRoot, branch } = current;
  if (!branch) {
    vscode.window.showWarningMessage("Estás en detached HEAD; no se puede guardar una base por branch.");
    return;
  }

  const branches = await listBranches(repoRoot);
  const pick = await vscode.window.showQuickPick(branches, {
    title: `Branch base para '${branch}'`,
    placeHolder: "Elegí contra qué branch comparar",
  });
  if (!pick) return;

  await resolver.setOverride(repoRoot, branch, pick);
  await refresh();
}

async function autoDetectCommand(): Promise<void> {
  if (!current) return;
  const { repoRoot, branch } = current;
  if (!branch) {
    vscode.window.showWarningMessage("Estás en detached HEAD; no se puede auto-detectar la base.");
    return;
  }

  const detected = await resolver.autoDetect(repoRoot, branch);
  if (!detected) {
    vscode.window.showInformationMessage("No se encontró un branch base candidato.");
    return;
  }

  const confirm = await vscode.window.showInformationMessage(
    `Base detectada: '${detected}'. ¿Usarla para '${branch}'?`,
    "Usar",
    "Cancelar"
  );
  if (confirm !== "Usar") return;

  await resolver.setOverride(repoRoot, branch, detected);
  await refresh();
}

async function clearBaseCommand(): Promise<void> {
  if (!current) return;
  const { repoRoot, branch } = current;
  if (!branch) return;
  await resolver.clearOverride(repoRoot, branch);
  await refresh();
}

/**
 * Actualiza la ref remota de la base (`git fetch origin <branch>`) y refresca.
 * Necesario para que la comparación matchee al PR del servidor: el merge-base
 * solo es correcto si `origin/<base>` está al día.
 */
async function fetchBaseCommand(): Promise<void> {
  if (!current?.base) return;
  const { repoRoot, base } = current;
  const remote = "origin";
  const branch = base.startsWith(`${remote}/`) ? base.slice(remote.length + 1) : base;

  await vscode.window.withProgress(
    { location: { viewId: "branchChangedFiles.view" }, title: `Fetch ${remote}/${branch}…` },
    async () => {
      try {
        await fetchBranch(repoRoot, remote, branch);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`No se pudo hacer fetch de ${remote}/${branch}: ${msg}`);
      }
    }
  );
  await refresh();
}

/** Abre un diff entre la base (merge-base) y el archivo en el working tree. */
async function openDiff(item: ChangedFileItem): Promise<void> {
  const fileUri = item.resourceUri!;
  const baseUri = toGitUri(fileUri, item.mergeBaseSha);

  if (!baseUri) {
    await vscode.commands.executeCommand("vscode.open", fileUri);
    return;
  }

  const title = `${item.file.relPath} (base ↔ working)`;
  try {
    await vscode.commands.executeCommand("vscode.diff", baseUri, fileUri, title);
  } catch {
    await vscode.commands.executeCommand("vscode.open", fileUri);
  }
}

/** Construye una git: URI para mostrar el contenido del archivo en una ref. */
function toGitUri(fileUri: vscode.Uri, ref: string): vscode.Uri | null {
  try {
    const ext = vscode.extensions.getExtension<any>("vscode.git");
    if (!ext?.isActive) return null;
    const api = ext.exports.getAPI(1);
    return api.toGitUri(fileUri, ref);
  } catch {
    return null;
  }
}
