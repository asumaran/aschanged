import * as vscode from "vscode";
import * as path from "node:path";
import { ChangedFile, FileStatus } from "./git";

/** Modo de presentación de la vista. */
export type ViewMode = "list" | "tree";

/** Nodo de la vista: un archivo cambiado. */
export class ChangedFileItem extends vscode.TreeItem {
  constructor(
    public readonly file: ChangedFile,
    public readonly repoRoot: string,
    public readonly mergeBaseSha: string,
    /** Etiqueta a mostrar: ruta completa (lista) o solo el nombre (árbol). */
    label: string = file.relPath
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);

    const absPath = path.join(repoRoot, file.relPath);
    this.resourceUri = vscode.Uri.file(absPath);
    // El ícono nativo del tipo de archivo lo aporta resourceUri.
    this.label = label;
    this.description = file.status === "pending" ? "pendiente" : "commiteado";
    this.tooltip = `${file.relPath}\n${
      file.status === "pending"
        ? "Tiene cambios sin commitear"
        : "Modificado en el branch (sin cambios pendientes)"
    }`;
    this.contextValue = "changedFile";
    // Click por defecto: abrir el archivo fuente. El diff queda en el botón inline.
    this.command = {
      command: "vscode.open",
      title: "Abrir archivo",
      arguments: [this.resourceUri],
    };
  }
}

/** Nodo de la vista: una carpeta que agrupa archivos cambiados (modo árbol). */
export class ChangedFolderItem extends vscode.TreeItem {
  public children: TreeNode[] = [];

  constructor(
    /** Ruta relativa de la carpeta respecto al root del repo (POSIX). */
    public readonly relPath: string,
    public readonly repoRoot: string,
    /** Etiqueta (nombre simple o segmentos fusionados con compact folders). */
    label: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.resourceUri = vscode.Uri.file(path.join(repoRoot, relPath));
    this.iconPath = vscode.ThemeIcon.Folder;
    this.contextValue = "changedFolder";
  }
}

export type TreeNode = ChangedFileItem | ChangedFolderItem;

export class ChangedFilesProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: TreeNode[] = [];

  setRoots(roots: TreeNode[]): void {
    this.roots = roots;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) return this.roots;
    if (element instanceof ChangedFolderItem) return element.children;
    return [];
  }
}

/** Nombre del último segmento de una ruta POSIX. */
function baseName(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? relPath : relPath.slice(i + 1);
}

/**
 * Construye los nodos raíz de la vista a partir de la lista de archivos.
 * En modo "list" devuelve un nodo por archivo con la ruta completa.
 * En modo "tree" arma carpetas anidadas, como la sección de archivos del Explorer.
 */
export function buildNodes(
  files: ChangedFile[],
  repoRoot: string,
  mergeBaseSha: string,
  mode: ViewMode,
  compactFolders: boolean
): TreeNode[] {
  if (mode === "list") {
    return files.map((f) => new ChangedFileItem(f, repoRoot, mergeBaseSha));
  }

  const root = new DirNode("", "");
  for (const f of files) {
    const parts = f.relPath.split("/");
    parts.pop(); // el nombre del archivo no es carpeta
    let dir = root;
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      let next = dir.dirs.get(part);
      if (!next) {
        next = new DirNode(part, acc);
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.push(f);
  }

  return toNodes(root, repoRoot, mergeBaseSha, compactFolders);
}

/** Estructura intermedia para armar el árbol de carpetas. */
class DirNode {
  readonly dirs = new Map<string, DirNode>();
  readonly files: ChangedFile[] = [];
  constructor(readonly name: string, readonly relPath: string) {}
}

/** Convierte el contenido (subcarpetas + archivos) de un DirNode en nodos de la vista. */
function toNodes(
  dir: DirNode,
  repoRoot: string,
  mergeBaseSha: string,
  compact: boolean
): TreeNode[] {
  const folders = [...dir.dirs.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((sub) => toFolder(sub, repoRoot, mergeBaseSha, compact));

  const fileItems = dir.files
    .sort((a, b) => baseName(a.relPath).localeCompare(baseName(b.relPath)))
    .map((f) => new ChangedFileItem(f, repoRoot, mergeBaseSha, baseName(f.relPath)));

  // Carpetas primero, luego archivos (como el Explorer).
  return [...folders, ...fileItems];
}

/** Construye un nodo de carpeta, fusionando cadenas de carpeta única si compact está activo. */
function toFolder(
  dir: DirNode,
  repoRoot: string,
  mergeBaseSha: string,
  compact: boolean
): ChangedFolderItem {
  let label = dir.name;
  let cur = dir;
  // Compact folders: "a" → "b" → archivos se muestra como "a/b".
  if (compact) {
    while (cur.files.length === 0 && cur.dirs.size === 1) {
      const only = [...cur.dirs.values()][0];
      label = `${label}/${only.name}`;
      cur = only;
    }
  }
  const folder = new ChangedFolderItem(cur.relPath, repoRoot, label);
  folder.children = toNodes(cur, repoRoot, mergeBaseSha, compact);
  return folder;
}

/**
 * Aporta un badge de color a los archivos según su estado, reutilizando los
 * colores del tema de git. Solo decora URIs que están en nuestros sets, así
 * que el impacto fuera de la vista es mínimo y coherente con git.
 */
export class StatusDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  private statusByPath = new Map<string, FileStatus>();

  update(repoRoot: string, files: ChangedFile[]): void {
    const changed: vscode.Uri[] = [];
    const next = new Map<string, FileStatus>();
    for (const f of files) {
      const fsPath = vscode.Uri.file(path.join(repoRoot, f.relPath)).fsPath;
      next.set(fsPath, f.status);
    }
    // URIs que cambiaron de estado (o aparecieron/desaparecieron).
    for (const key of new Set([...this.statusByPath.keys(), ...next.keys()])) {
      if (this.statusByPath.get(key) !== next.get(key)) {
        changed.push(vscode.Uri.file(key));
      }
    }
    this.statusByPath = next;
    this._onDidChange.fire(changed);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const status = this.statusByPath.get(uri.fsPath);
    if (!status) return undefined;
    if (status === "pending") {
      return {
        badge: "●",
        tooltip: "Cambios sin commitear",
        color: new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
      };
    }
    return {
      badge: "✓",
      tooltip: "Modificado en el branch (commiteado)",
      color: new vscode.ThemeColor("descriptionForeground"),
    };
  }
}
