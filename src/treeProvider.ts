import * as vscode from "vscode";
import * as path from "node:path";
import { ChangedFile, FileStatus } from "./git";

/** Nodo de la vista: un archivo cambiado (lista plana). */
export class ChangedFileItem extends vscode.TreeItem {
  constructor(
    public readonly file: ChangedFile,
    public readonly repoRoot: string,
    public readonly mergeBaseSha: string
  ) {
    super(file.relPath, vscode.TreeItemCollapsibleState.None);

    const absPath = path.join(repoRoot, file.relPath);
    this.resourceUri = vscode.Uri.file(absPath);
    // Etiqueta = ruta relativa completa (vista plana). El ícono nativo del
    // tipo de archivo lo aporta resourceUri.
    this.label = file.relPath;
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

export class ChangedFilesProvider implements vscode.TreeDataProvider<ChangedFileItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private items: ChangedFileItem[] = [];

  setItems(items: ChangedFileItem[]): void {
    this.items = items;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ChangedFileItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ChangedFileItem): ChangedFileItem[] {
    if (element) return []; // lista plana: sin hijos
    return this.items;
  }
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
