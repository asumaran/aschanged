# Branch Changed Files

Una sección en el Explorer de VSCode que lista los archivos modificados en el
branch actual **respecto a su branch base**, diferenciando lo ya commiteado de
lo que tiene cambios sin commitear.

## Qué muestra

- Una vista **Branch Changes** dentro del Explorer (lista plana de rutas).
- En el header: `branch_actual ← base` (con `(manual)` si la base es un override).
- Cada archivo con un badge:
  - `●` (color de modificado) → **pendiente**: tiene cambios sin commitear.
  - `✓` (atenuado) → **commiteado**: modificado en el branch, sin cambios pendientes.
- Click en un archivo → diff entre la **base (merge-base)** y el working tree.

## Cómo se elige la base

Jerarquía:

1. **Override manual por branch** (comando *Elegir branch base...*), recordado
   por branch en el workspace.
2. **Branch principal** del repo (`origin/HEAD`, o el primer candidato de
   `mainBranchCandidates`).

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
