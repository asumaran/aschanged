# Branch Changed Files

Una sección en el Explorer de VSCode que lista los archivos modificados en el
branch actual **respecto a su branch base**, diferenciando lo ya commiteado de
lo que tiene cambios sin commitear.

## Qué muestra

- Una vista **Branch Changes** dentro del Explorer.
- Dos modos de presentación, alternables con el botón en la barra de la vista
  (igual que el toggle list/tree de Source Control):
  - **Árbol de carpetas** (default): archivos anidados por carpeta, como la
    sección de archivos del Explorer. Respeta `explorer.compactFolders`.
  - **Lista plana**: un nodo por archivo con la ruta relativa completa.
  - El modo elegido se recuerda entre sesiones.
- En el header: `branch_actual ← base` (con `(manual)` si la base es un override).
- Cada archivo con un badge:
  - `●` (color de modificado) → **pendiente**: tiene cambios sin commitear.
  - `✓` (atenuado) → **commiteado**: modificado en el branch, sin cambios pendientes.
- Click en un archivo → diff entre la **base (merge-base)** y el working tree.

## Cómo se elige la base

Jerarquía:

1. **Override manual por branch** (comando *Elegir branch base...*), recordado
   por branch en el workspace.
2. **Branch principal** del repo, preferentemente la **ref remota**
   (`origin/master`) por sobre la local (`master`), tomada de `origin/HEAD` o
   del primer candidato de `mainBranchCandidates`.

### Por qué `origin/master` y no `master`

GitHub/GitLab calculan los archivos del PR con un **three-dot diff**
(`base...head`), cuyo merge-base es el punto de divergencia contra el master
**del servidor**. `origin/master` es el espejo local de ese estado; el `master`
local suele estar atrasado y, al correr el merge-base hacia atrás, arrastra
archivos de commits ajenos al branch (aparecen "de más").

Por eso la comparación apunta a `origin/*`. Para que coincida exactamente con
el PR, `origin/master` debe estar al día: usá el botón **Fetch del branch base**
(o `git fetch`) si ves discrepancias.

El **merge-base más cercano** existe como botón explícito (*Auto-detectar branch
base*), no como default silencioso: detecta el caso de branches apilados
(`feature_x → feature_z`) y, si confirmás, lo guarda como override.

Con `branchChangedFiles.alwaysCompareToMain: true` se ignoran los overrides y se
compara siempre contra el branch principal.

## Por qué no detecta la base "sola"

Git no almacena de qué branch nació un branch (un branch es solo un puntero a un
commit). Lo que sí sabe es calcular el punto de divergencia (`merge-base`) contra
una ref dada. Por eso la base es una **elección** (manual o el principal), igual
que el "compare against" de clientes como Tower.

## Configuración

| Opción | Default | Descripción |
|---|---|---|
| `branchChangedFiles.alwaysCompareToMain` | `false` | Forzar siempre el branch principal. |
| `branchChangedFiles.mainBranchCandidates` | `["main","master","develop"]` | Candidatos a base por defecto. |
| `branchChangedFiles.respectFilesExclude` | `true` | Ocultar archivos que matchean `files.exclude`. |

> `.gitignore` (node_modules, .env, etc.) ya lo filtra git: esos archivos no
> aparecen en el diff ni en el status. `files.exclude` se aplica encima.

## Desarrollo

```bash
npm install
npm run watch      # build incremental con esbuild
# F5 en VSCode -> "Run Extension"
```

## Limitaciones (v0.1)

- Usa el primer workspace folder / repo. Multi-repo es una mejora futura.
- La integración con la base del PR de GitHub/GitLab queda como fase posterior.
- Los archivos **pendientes** (sin commitear) se muestran aunque no estén en el
  PR del servidor: es intencional, pero explica diferencias de conteo con GitHub.
- `origin/<base>` se compara tal como esté en local; si no hiciste fetch reciente
  puede estar atrasado. *Fetch del branch base* lo actualiza.
