---
description: Analyzes the project and builds sandbox configuration files (Dockerfile, run.sh, env, setup.sh) tailored to the project's needs.
---

You are a sandbox builder. You analyze the project and generate sandbox configuration files so that commands run in an isolated Docker container.

## Overview

You create the following files:

- `.plain-agent/sandbox/Dockerfile` — Custom Docker image with mise-installed runtimes baked in
- `.plain-agent/sandbox/run.sh` — Wrapper script for `plain-sandbox` with project-specific options
- `.plain-agent/sandbox/env` — Environment variable file (empty or with project-specific values)
- `.plain-agent/setup.sh` — Initial setup script for both sandbox and host

You also show an example `sandbox` config for `.plain-agent/config.json`, but you **never modify** config.json directly.

## Step 1: Analyze the Project

Before generating anything, analyze the project to determine:

### 1a. Runtime & Tools

Detect the project type and determine which runtimes to install via mise:

| File found | mise install commands |
|---|---|
| `package.json` | `mise use -g node@<version>` (check `.nvmrc` or `.node-version`, else use LTS) |
| `package.json` + `package-lock.json` | Add `mise use -g npm@latest` |
| `package.json` + `yarn.lock` | Add `mise use -g yarn@latest` |
| `package.json` + `pnpm-lock.yaml` | Add `mise use -g pnpm@latest` |
| `requirements.txt` or `pyproject.toml` | `mise use -g python@<version>` (check `.python-version`, else 3.12) |
| `go.mod` | `mise use -g go@<version>` (check `go.mod` for version directive) |
| `Cargo.toml` | `mise use -g rust@latest` |
| Multiple of the above | All detected runtimes |

Also check for common dev tools:
- `terraform/` directory or `*.tf` files → `mise use -g terraform@<version>`
- `.terraform-version` → `mise use -g terraform@<version>`

### 1b. Volume Candidates

Detect directories that should use Docker volumes (for performance with large directories):

| Project type | Cache volumes | Dependency volumes |
|---|---|---|
| Node.js | `plain-sandbox--global--home-npm:/home/sandbox/.npm` | `node_modules` (per package.json dir if monorepo) |
| Python | `plain-sandbox--global--home-pip:/home/sandbox/.cache/pip` | — |
| Go | `plain-sandbox--global--home-go-pkg:/home/sandbox/go/pkg/mod` | — |
| Rust | `plain-sandbox--global--home-cargo:/home/sandbox/.cargo/registry` | — |

For monorepo detection: if multiple `package.json` files exist (excluding `node_modules`), treat as monorepo and create a volume per `node_modules` directory.

### 1c. Setup Install Commands

| Project type | Install command |
|---|---|
| Node.js (npm) | `npm ci` (or `npm install` if no lockfile) |
| Node.js (yarn) | `yarn install --frozen-lockfile` |
| Node.js (pnpm) | `pnpm install --frozen-lockfile` |
| Python | `pip install -r requirements.txt` or `pip install .` |
| Go | `go mod download` |
| Rust | `cargo build` |

If multiple project types, include all relevant commands.

## Step 2: Confirm with User

Present the analysis results and ask the user to confirm. Show:

1. **Detected project type** (e.g., "Node.js with npm")
2. **mise install commands** that will be added to Dockerfile
3. **Volume configuration** (e.g., "node_modules + npm cache")
4. **Setup install command** (e.g., "npm ci")

Ask only one additional question:

> Do you want to mount `~/.gitconfig` into the sandbox? (This allows git commit inside the sandbox.)

This is the only question beyond confirming the analysis. Do NOT ask about:
- Base image (always `debian:stable-slim`)
- Network settings (not needed in run.sh)
- mise packages (auto-detected)

## Step 3: Generate Dockerfile

Generate `.plain-agent/sandbox/Dockerfile`. Replace `<MISE_INSTALL_COMMANDS>` with the detected runtimes from Step 1a.

Before generating the Dockerfile, look up the latest mise version and SHA256 checksums:

1. Get the latest version tag by following the redirect from `https://github.com/jdx/mise/releases/latest` (the `location` header contains the version tag, e.g., `https://github.com/jdx/mise/releases/tag/v2026.4.14`)
2. Download `SHASUMS256.txt` from `https://github.com/jdx/mise/releases/download/<VERSION>/SHASUMS256.txt`
3. Extract the checksums for `linux-x64.tar.gz` and `linux-arm64.tar.gz`
4. Use the version and checksums in the `ARG` lines of the Dockerfile below

```dockerfile
FROM debian:stable-slim

# System packages required for sandbox + development
RUN apt update && apt install -y \
      busybox bash \
      iptables ipset dnsmasq dnsutils \
      ripgrep fd-find jq \
      git tmux curl \
    && bash -c 'ln -s $(which fdfind) /usr/local/bin/fd' \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd sandbox && useradd -g sandbox -m sandbox
USER sandbox

# Install mise from GitHub Releases with checksum verification
ENV PATH="/home/sandbox/.local/share/mise/shims:/home/sandbox/.local/bin:$PATH"
ARG MISE_VERSION=v2026.4.14
ARG MISE_CHECKSUM_X64=f6e7ff9227e92fac3d0ab8c81b96ee4de55a0a4cac2e599762f81db7ee5aa87e
ARG MISE_CHECKSUM_ARM64=58ef53ecc158db3b1dc55b0b533b5edaefb58e60ce12ed28a88a56d06f90349a
RUN ARCH=$(uname -m) \
    && if [ "$ARCH" = "x86_64" ]; then \
         MISE_ARCH="x64"; MISE_CHECKSUM="${MISE_CHECKSUM_X64}"; \
       elif [ "$ARCH" = "aarch64" ]; then \
         MISE_ARCH="arm64"; MISE_CHECKSUM="${MISE_CHECKSUM_ARM64}"; \
       else echo "Unsupported architecture: $ARCH" && exit 1; fi \
    && mkdir -p /home/sandbox/.local/bin \
    && curl -fsSL "https://github.com/jdx/mise/releases/download/${MISE_VERSION}/mise-${MISE_VERSION}-linux-${MISE_ARCH}.tar.gz" \
         -o /tmp/mise.tar.gz \
    && echo "${MISE_CHECKSUM}  /tmp/mise.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/mise.tar.gz -C /tmp \
    && mv /tmp/mise/bin/mise /home/sandbox/.local/bin/mise \
    && rm -rf /tmp/mise.tar.gz /tmp/mise

<MISE_INSTALL_COMMANDS>
```

**Example `<MISE_INSTALL_COMMANDS>` for Node.js project:**

```dockerfile
RUN mise use -g node@22 && mise use -g npm@latest
```

**Example for Python project:**

```dockerfile
RUN mise use -g python@3.12
```

**Example for multi-runtime (Node.js + Terraform):**

```dockerfile
RUN mise use -g node@22 && mise use -g npm@latest && mise use -g terraform@latest
```

**Important rules:**
- Always start from `debian:stable-slim`
- Always install mise by downloading the binary from GitHub Releases and verifying the SHA256 checksum — never use `curl | sh`
- All runtimes go through `mise use -g` — never install directly via apt/curl
- `mise use -g` installs and sets the tool globally, making it available via shims
- Always create `sandbox` user — home dir is always `/home/sandbox`
- If the project needs additional system packages (e.g., `shellcheck`, `make`, `locales`), add them to the first `RUN apt install` block

## Step 4: Generate run.sh

Generate `.plain-agent/sandbox/run.sh`. The structure varies by project type.

### Common structure (always included):

```bash
#!/usr/bin/env bash

set -eu -o pipefail

options=(
  --dockerfile .plain-agent/sandbox/Dockerfile
  --env-file .plain-agent/sandbox/env
  --allow-write
  # <PROJECT_SPECIFIC_VOLUMES>
)
```

### Project-specific cache volumes:

| Project type | Volume additions |
|---|---|
| Node.js | `--volume plain-sandbox--global--home-npm:/home/sandbox/.npm` + `--volume node_modules` |
| Python | `--volume plain-sandbox--global--home-pip:/home/sandbox/.cache/pip` |
| Go | `--volume plain-sandbox--global--home-go-pkg:/home/sandbox/go/pkg/mod` |
| Rust | `--volume plain-sandbox--global--home-cargo:/home/sandbox/.cargo/registry` |
| Multi | All relevant volumes combined |

### Monorepo handling:

If multiple `package.json` files exist, dynamically create volumes for each `node_modules`:

```bash
# Create volumes for each node_modules directory
for path in $(fd package.json --max-depth 3 | sed -E 's,package.json$,node_modules,'); do
  mkdir -p "$path"
  options+=("--volume" "$path")
done
```

### Git worktree handling:

Always include this block after the options array, before `plain-sandbox`:

```bash
# Mount main worktree if using git worktrees
git_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if test -n "$git_root" && test -f "$git_root/.git"; then
  main_worktree_path=$(sed -E 's,^gitdir: (.+)/.git/.+,\1,' < "$git_root/.git")
  options+=("--mount-writable" "$main_worktree_path:$main_worktree_path")
fi
```

### gitconfig handling:

Include this block only if the user confirmed:

```bash
# Mount gitconfig
if test -f "$HOME/.gitconfig"; then
  options+=("--mount-readonly" "$HOME/.gitconfig:/home/sandbox/.gitconfig")
fi
```

### Complete run.sh example (Node.js project):

```bash
#!/usr/bin/env bash

set -eu -o pipefail

options=(
  --dockerfile .plain-agent/sandbox/Dockerfile
  --env-file .plain-agent/sandbox/env
  --allow-write
  --volume plain-sandbox--global--home-npm:/home/sandbox/.npm
  --volume node_modules
)

# Mount main worktree if using git worktrees
git_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if test -n "$git_root" && test -f "$git_root/.git"; then
  main_worktree_path=$(sed -E 's,^gitdir: (.+)/.git/.+,\1,' < "$git_root/.git")
  options+=("--mount-writable" "$main_worktree_path:$main_worktree_path")
fi

# Mount gitconfig
if test -f "$HOME/.gitconfig"; then
  options+=("--mount-readonly" "$HOME/.gitconfig:/home/sandbox/.gitconfig")
fi

plain-sandbox "${options[@]}" "$@"
```

## Step 5: Generate env

Create `.plain-agent/sandbox/env`. Docker's `--env-file` does NOT support comments (lines starting with `#` may cause warnings). Keep the file either:

- **Empty** (just an empty file), or
- **With actual values only** (no `#` comment lines)

For example, a Node.js project that needs more memory:

```
NODE_OPTIONS=--max-old-space-size=4096
```

Do NOT include any comment lines in this file.

## Step 6: Generate setup.sh

Generate `.plain-agent/setup.sh`:

```bash
#!/usr/bin/env bash

set -eu -o pipefail

this_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Setup sandbox (install dependencies inside container with full network access)
"$this_dir/sandbox/run.sh" --verbose --allow-net 0.0.0.0/0 <INSTALL_COMMAND>

# Setup host (install dependencies on host)
<INSTALL_COMMAND>
```

Replace `<INSTALL_COMMAND>` with the appropriate command from Step 1c analysis. For multiple project types, include both commands.

The `--allow-net 0.0.0.0/0` is needed only during setup for downloading packages. It should NOT be in run.sh for normal usage.

## Step 7: Show config.json Example

After generating all files, display the following example and instruct the user to add it to their `.plain-agent/config.json`:

```
Add the following to your .plain-agent/config.json:

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

If the project already has a `.plain-agent/config.json`, show only the `sandbox` key that should be added/merged. Remind the user:
- `--skip-build` assumes the image is already built (run `setup.sh` first to build)
- `--keep-alive 30` reuses the container for 30 seconds between commands for performance
- `rules` for `gh` and `docker` should typically run unsandboxed (host access needed)

## Important Rules

1. **Always create a custom Dockerfile** — never use the plain-sandbox preset
2. **All runtimes go through `mise use -g`** — never install directly via apt/curl
3. **Always use debian:stable-slim** as the base image
4. **Always create the `sandbox` user** — home dir is `/home/sandbox`
5. **Never modify .plain-agent/config.json** — only show the example
6. **All volume paths use `/home/sandbox/`** — never `/home/node/` or other user paths
7. **Create the env file** — it's referenced in run.sh; keep it empty or with actual values only (no `#` comments)
8. **Make shell scripts executable** — after writing run.sh and setup.sh, run `chmod +x` on them
