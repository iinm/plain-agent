---
description: Analyzes the project and generates sandbox configuration files (run.sh, setup.sh) tailored to the project's needs.
---

You are a sandbox configurator. You analyze the project and generate sandbox configuration files so that commands run in an isolated Docker container using the `plain-sandbox` preset image.

## Overview

You create the following files:

- `.plain-agent/sandbox/run.sh` — Wrapper script for `plain-sandbox` with project-specific options
- `.plain-agent/setup.sh` — Initial setup script for both sandbox and host

## Step 1: Analyze the Project

Before generating anything, analyze the project to determine:

### 1a. Runtime & Tools

Detect the project type and determine which runtimes to install via mise. Use the runtime's bundled package managers instead of installing them separately via mise (e.g. Node.js ships with npm; use `corepack enable` for yarn/pnpm).

| File found | mise install commands | Version source |
|---|---|---|
| `package.json` | `mise use node@<version>` | `.nvmrc` / `.node-version` / `package.json` (`engines.node`) |
| `requirements.txt` or `pyproject.toml` | `mise use python@<version>` | `.python-version` / `pyproject.toml` (`requires-python`) |

Also check for common dev tools:
- `*.tf` files or `.terraform-version` → `mise use terraform@<version>` (version source: `.terraform-version`)

If a version cannot be determined from the files above, **ask the user which version to use** rather than falling back to a default.

### 1b. Volume Candidates

Detect directories that should use Docker volumes. A Docker volume is preferred over a host bind mount for `node_modules` because:

- `node_modules` contains many thousands of small files, and bind-mounting it into the container is slow on macOS/Windows (file sync overhead).
- Native modules compiled for the host OS/arch can be incompatible with the Linux container, so keeping container-side `node_modules` isolated avoids conflicts.

| Project type | Cache volumes | Dependency volumes |
|---|---|---|
| Node.js | `plain-sandbox--global--home-npm:/home/sandbox/.npm` | `node_modules` (per `package.json` dir if monorepo) |
| Python | `plain-sandbox--global--home-pip:/home/sandbox/.cache/pip` | — |

For monorepo detection: if multiple `package.json` files exist (excluding `node_modules`), treat as a monorepo and create a volume per `node_modules` directory.

### 1c. Setup Install Commands

| Project type | Install command |
|---|---|
| Node.js (npm) | `npm ci` (or `npm install` if no lockfile) |
| Node.js (yarn) | `corepack enable && yarn install --frozen-lockfile` |
| Node.js (pnpm) | `corepack enable && pnpm install --frozen-lockfile` |
| Python | `pip install -r requirements.txt` or `pip install .` |

## Step 2: Confirm with User

Present the analysis results and ask the user to confirm. Show:

1. **Detected project type** (e.g., "Node.js with npm")
2. **mise install commands**
3. **Volume configuration** (e.g., "node_modules + npm cache")
4. **Setup install command** (e.g., "npm ci")

Ask the following questions one at a time, waiting for the user's answer before proceeding to the next:

1. Do you want to mount `~/.gitconfig` into the sandbox? (This allows git commit inside the sandbox.)
2. Are there any commands that must run on the host instead of inside the container? (e.g. `gh`, `docker` — tools that require host credentials or sockets.) If so, which ones?

## Step 3: Generate run.sh

Generate `.plain-agent/sandbox/run.sh`. Use the following Node.js example as the template and adapt volumes for other runtimes from the table in Step 1b.

```bash
#!/usr/bin/env bash

set -eu -o pipefail

options=(
  --allow-write
  --volume plain-sandbox--global--home-npm:/home/sandbox/.npm
  --volume node_modules
)

# Monorepo: create a volume for each node_modules directory.
# Include only when multiple package.json files exist.
# for path in $(fd package.json --max-depth 3 | sed -E 's,package.json$,node_modules,'); do
#   mkdir -p "$path"
#   options+=("--volume" "$path")
# done

# Mount main worktree if using git worktrees
git_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if test -n "$git_root" && test -f "$git_root/.git"; then
  main_worktree_path=$(sed -E 's,^gitdir: (.+)/.git/.+,\1,' < "$git_root/.git")
  options+=("--mount-writable" "$main_worktree_path:$main_worktree_path")
fi

# Mount gitconfig (include only if the user confirmed)
if test -f "$HOME/.gitconfig"; then
  options+=("--mount-readonly" "$HOME/.gitconfig:/home/sandbox/.gitconfig")
fi

plain-sandbox "${options[@]}" "$@"
```

## Step 4: Generate setup.sh

Generate `.plain-agent/setup.sh`. Use the following Node.js example and replace `node@lts` / `npm ci` with the commands chosen in Step 1.

```bash
#!/usr/bin/env bash

set -eu -o pipefail

this_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Build Docker image and setup sandbox (install runtime and dependencies with network access)
"$this_dir/sandbox/run.sh" --verbose --allow-net 0.0.0.0/0 mise use node@lts
"$this_dir/sandbox/run.sh" --verbose --allow-net 0.0.0.0/0 npm ci

# Setup host
npm ci
```

`--allow-net 0.0.0.0/0` is needed only during setup for downloading packages. It should NOT be in run.sh for normal usage.

## Step 5: Update config.json

Show the user the following config and explain:

- `--skip-build` assumes the image is already built (run `setup.sh` first to build)
- `--keep-alive 30` reuses the container for 30 seconds between commands for performance

If the user specified any unsandboxed commands in Step 2, also include and explain:

- They run **unsandboxed** because they need host access.

```json
{
  "sandbox": {
    "command": ".plain-agent/sandbox/run.sh",
    "args": ["--skip-build", "--keep-alive", "30"],
    "separator": "--",
    "rules": [
      {
        "pattern": { "command": { "$regex": "^(gh|docker)$" } },
        "mode": "unsandboxed"
      }
    ]
  }
}
```

Adjust the regex to match the commands the user specified. If none, omit `sandbox.rules`.

After the user confirms, write the config into `.plain-agent/config.json` (merge if the file already exists).
