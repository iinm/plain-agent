# Plain Agent

[![CodeQL](https://github.com/iinm/plain-agent/actions/workflows/github-code-scanning/codeql/badge.svg)](https://github.com/iinm/plain-agent/actions/workflows/github-code-scanning/codeql)
[![Socket Badge](https://badge.socket.dev/npm/package/@iinm/plain-agent/1.13.1)](https://socket.dev/npm/package/@iinm/plain-agent)
[![install size](https://packagephobia.com/badge?p=@iinm/plain-agent)](https://packagephobia.com/result?p=@iinm/plain-agent)

A lightweight terminal-based coding agent focused on safety and low token cost

## Table of Contents

- [Design](#design)
  - [Multi-Provider Support](#multi-provider-support)
  - [Auto-Approval](#auto-approval)
  - [Path Validation](#path-validation)
  - [Sandbox](#sandbox)
  - [Memory File](#memory-file)
  - [Token Efficiency](#token-efficiency)
  - [Claude Code Compatibility](#claude-code-compatibility)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Available Tools](#available-tools)
- [Prompts](#prompts)
- [Subagents](#subagents)
- [Claude Code Plugin Support](#claude-code-plugin-support)
- [Appendix: Creating Least-Privilege Users for Cloud Providers](#appendix-creating-least-privilege-users-for-cloud-providers)
- [Developer Notes](#developer-notes)

## Design

### Multi-Provider Support

Supports Claude, OpenAI, Gemini, and any OpenAI-compatible provider. Bedrock, Vertex AI, and Azure are also supported for teams working in environments restricted to managed cloud providers.

Each model definition has two independent parts:

- **`platform`** — where to send the request and how to authenticate (Anthropic, Bedrock, Vertex AI, Azure, etc.)
- **`model.format`** — which API format to use (`anthropic`, `gemini`, `openai-responses`, `openai-messages`, `bedrock-converse`)

Because these are separate, the same API format works across different platforms. For example, Claude models use the `anthropic` format whether you call Anthropic directly or through Bedrock.

```js
// Anthropic direct
{
  "name": "claude-sonnet-4-6",
  "variant": "thinking-high",
  "platform": {
    "name": "anthropic",
    "variant": "default"
  },
  "model": {
    "format": "anthropic",
    "config": {
      "model": "claude-sonnet-4-6",
      "max_tokens": 32768,
      "thinking": { "type": "adaptive" },
      "output_config": { "effort": "high" }
    }
  }
}

// Bedrock — same format, different platform
{
  "name": "claude-sonnet-4-6",
  "variant": "thinking-high-bedrock-jp",
  "platform": {
    "name": "bedrock",
    "variant": "jp"
  },
  "model": {
    "format": "anthropic",
    "config": {
      "model": "jp.anthropic.claude-sonnet-4-6",
      "max_tokens": 32768,
      "thinking": { "type": "adaptive" },
      "output_config": { "effort": "high" }
    }
  }
}
```

Models are identified by `name+variant` (e.g., `claude-sonnet-4-6+thinking-high`). You can define multiple variants of the same model with different settings — such as thinking budget or region — and switch between them as needed.

You can also add entries to `platforms` and `models` to use any OpenAI-compatible endpoint, such as Ollama or Fireworks. See the Quick Start section for examples.

### Auto-Approval

Configure what the agent can do automatically using a small DSL with regex matching. Below is an excerpt from the [default config](https://github.com/iinm/plain-agent/blob/main/config/config.predefined.json).

**Note**: Commands are executed without a shell — shell operators like `&&`, `|`, `;`, and redirects are not interpreted unless the agent explicitly uses `bash -c`. This makes each argument a discrete token that can be validated individually.

```js
{
  "autoApproval": {
    // What to do when no pattern matches: ask - prompt the user, deny - reject automatically
    "defaultAction": "ask",

    // Patterns are evaluated top-to-bottom; first match wins
    "patterns": [
      // fd example:
      // Ask for approval when risky flags like --exec or --no-ignore are present
      {
        "toolName": "exec_command",
        "input": {
          "command": "fd",
          "args": { "$has": { "$regex": "^(--unrestricted|--no-ignore|--exec|--exec-batch|--follow|-[^-]*[uIxXL])" } }
        },
        "action": "ask"
      },
      // Allow all other fd calls
      {
        "toolName": "exec_command",
        "input": { "command": "fd" },
        "action": "allow"
      },

      // GitHub CLI example:
      // Allow read access to PRs and issues
      {
        "toolName": "exec_command",
        "input": {
          "command": "gh",
          "args": ["api", "--method", "GET", { "$regex": "^repos/[^/]+/[^/]+/(pulls|issues)/" }]
        },
        "action": "allow"
      },
      // Require --method to be explicit, so GET calls can be safely auto-approved
      {
        "toolName": "exec_command",
        "input": { "command": "gh", "args": ["api", { "$not": { "$regex": "^--(method|help)" } }] },
        "action": "deny",
        "reason": "--method must be specified right after 'api'"
      }
    ],

    // Test cases for verifying patterns. Run: plain test-approval
    "tests": [
      {
        "desc": "fd with safe args should be allowed",
        "toolUse": { "toolName": "exec_command", "input": { "command": "fd", "args": ["README", "./"] } },
        "expectedAction": "allow"
      },
      {
        "desc": "fd with --exec should require approval",
        "toolUse": { "toolName": "exec_command", "input": { "command": "fd", "args": [".env", "./", "--exec", "cat", "{}"] } },
        "expectedAction": "ask"
      },
      {
        "desc": "gh api without --method should be denied",
        "toolUse": { "toolName": "exec_command", "input": { "command": "gh", "args": ["api", "/repos/owner/repo/pulls"] } },
        "expectedAction": "deny"
      }
    ]
  }
}
```

### Path Validation

String values in tool inputs are treated as file paths and validated against these rules. This takes precedence over `autoApproval` — even if a pattern marks an action as `allow`, a validation failure falls back to `defaultAction`.

- The path must be under the working directory or a path listed in `autoApproval.allowedPaths`
- No directory traversal (`..` is not allowed)
- Symlinks are resolved to their real path before validation — a symlink inside the working directory that points outside is rejected. Broken and circular symlinks are also rejected.
- The file must be tracked by Git (not ignored)

Compound arguments are decomposed before validation — embedded paths are extracted and checked individually:

| Pattern | Example | Extracted |
|---|---|---|
| `@<path>` | `@data.json` | `data.json` |
| `--opt=<val>` | `--prefix=/tmp/foo` | `/tmp/foo` |
| `-X<val>` | `-I/usr/include` | `/usr/include` |
| `VAR=<val>` | `OUTPUT=/etc/passwd` | `/etc/passwd` |
| `proto://…` | `file:///etc/passwd` | `/etc/passwd` (only `file:` is treated as a local path; `http(s)://` URLs are always allowed) |

`--opt=<val>`, `-X<val>`, and `VAR=<val>` are checked recursively, so chained patterns like `-DINSTALL_DIR=/etc` decompose fully (`-D` → `INSTALL_DIR=/etc` → `/etc`).

**Note**: Validation only applies when the agent explicitly passes file paths to tools. It cannot catch file access inside scripts the agent writes — something like `bash -c "rm -rf /"` is beyond its reach. Always use a sandbox when auto-approving script execution.

### Sandbox

The agent can run arbitrary commands via `exec_command` and `tmux_command`. You can configure a wrapper command that intercepts both.
A Docker-based wrapper called `plain-sandbox` is included, but the interface is designed to work with other tools as well, such as [Anthropic Sandbox Runtime (srt)](https://github.com/anthropic-experimental/sandbox-runtime).

```js
{
  "sandbox": {
    // Commands are wrapped and executed with this command
    "command": "plain-sandbox",
    "args": ["--allow-write", "--mount-readonly", ".plain-agent/config.json", "--keep-alive", "30"],
    // ↑ --mount-readonly: prevents the agent from overwriting its own config
    // separator is inserted between sandbox flags and the user command to prevent bypasses
    "separator": "--",

    "rules": [
      // Run specific commands outside the sandbox
      {
        "pattern": {
          "command": { "$regex": "^(gh|docker)$" }
        },
        "mode": "unsandboxed"
      },
      // Run commands in the sandbox with network access
      {
        "pattern": {
          "command": "npm",
          "args": [{ "$regex": "^(install|ci)$" }]
        },
        "mode": "sandbox",
        "additionalArgs": ["--allow-net", "registry.npmjs.org"]
      }
    ]
  }
}
```

### Memory File

The agent maintains a memory file (`.plain-agent/memory/`) for each session to:

- Keep task state human-readable — you can open the file to see exactly where things stand.
- Resume cleanly — the agent can restart a task from the memory file with a clean context.
- Pass information between dependent tasks — subagents write their results to the memory file, which the main agent or a follow-up session reads to continue.

### Token Efficiency

A few design choices keep token usage low:

- Minimal system prompt — the [system prompt](https://github.com/iinm/plain-agent/blob/main/src/prompt.mjs) contains only what the agent needs to function. 
- Output truncation — when a command or MCP tool produces large output, it is truncated and saved to a file. The agent can then read only the relevant parts.
- Context compaction — run `/compact` to discard old messages and reload task state from a memory file. This also happens automatically when input tokens exceed a configurable soft limit (see [Auto-Compact](#auto-compact)).
- MCP tool filtering — MCP servers often expose many tools. Use `enabledTools` in the server config to enable only the ones you need, which reduces the number of tool definitions sent to the model.

### Claude Code Compatibility

Claude Code has a plugin ecosystem and is widely used across teams. plain-agent supports `.claude/` commands, subagents, and skills so you can share project skills with Claude Code users. Plugins can also be installed.

**Limitation:** Subagents run sequentially, not in parallel. The upside is that their activity is fully observable and they don't spike token usage. They also inherit the main context rather than starting fresh — a simplification chosen for ease of implementation, which also avoids redundant file reads and reduces the chance of losing context between handoffs.

## Requirements

- Node.js 22 or later
- Credentials for your LLM provider
- [ripgrep](https://github.com/burntsushi/ripgrep), [fd](https://github.com/sharkdp/fd)
- Bash and Docker for sandboxed execution

## Quick Start

```sh
npm install -g @iinm/plain-agent
```

List the available models.

```sh
plain list-models
```

Create a configuration file.

```js
// ~/.config/plain-agent/config.local.json
{
  // Set default model
  "model": "claude-sonnet-4-6+thinking-high",

  // Configure the providers you want to use
  "platforms": [
    {
      "name": "anthropic",
      "variant": "default",
      "apiKey": "<ANTHROPIC_API_KEY>"
      // Or read from environment variable
      // "apiKey": { "$env": "ANTHROPIC_API_KEY" }
    },
    {
      "name": "gemini",
      "variant": "default",
      "apiKey": "<GEMINI_API_KEY>"
    },
    {
      "name": "openai",
      "variant": "default",
      "apiKey": "<OPENAI_API_KEY>"
    }
  ],

  // Optional: enable web tools
  "tools": {
    "webSearch": {
      "provider": "gemini",
      "apiKey": "<GEMINI_API_KEY>",
      "model": "gemini-3.5-flash"

      // Or use Vertex AI (requires the gcloud CLI for authentication)
      // "provider": "gemini-vertex-ai",
      // "baseURL": "https://aiplatform.googleapis.com/v1beta1/projects/<project_id>/locations/<location>",
      // "model": "gemini-3.5-flash"

      // Or use a custom command
      // "provider": "command",
      // "command": "bash",
      // "args": ["-c", "w3m -dump -o display_link_number=1 \"https://lite.duckduckgo.com/lite?q=$*\"", "-"]
    },

    "webFetch": {
      "provider": "gemini",
      "apiKey": "<GEMINI_API_KEY>",
      "model": "gemini-3.5-flash"

      // Or use Vertex AI (requires the gcloud CLI for authentication)

      // Or use a custom command
      // "provider": "command",
      // "command": "w3m",
      // "args": ["-dump", "-o", "display_link_number=1"]
    }
  }
}
```

<details>
<summary><b>Bedrock / Vertex AI / Azure provider examples</b></summary>

```js
{
  "platforms": [
    // Bedrock: Requires the AWS CLI for authentication
    {
      "name": "bedrock",
      "variant": "default",
      "baseURL": "https://bedrock-runtime.<region>.amazonaws.com",
      "awsProfile": "<AWS_PROFILE>"
    },

    // Vertex AI: Requires the gcloud CLI for authentication
    {
      "name": "vertex-ai",
      "variant": "default",
      "baseURL": "https://aiplatform.googleapis.com/v1beta1/projects/<project>/locations/<location>",
      // Optional: impersonate this service account to obtain an auth token
      "account": "<SERVICE_ACCOUNT_EMAIL>"
    },

    // Azure: Requires the Azure CLI for authentication
    {
      "name": "azure",
      "variant": "default",
      "baseURL": "https://<resource>.services.ai.azure.com",
      // Optional
      "azureConfigDir": "/home/xxx/.azure-for-agent"
    },
    // Azure OpenAI
    {
      "name": "azure",
      "variant": "openai",
      "baseURL": "https://<resource>.openai.azure.com/openai",
      // Optional
      "azureConfigDir": "/home/xxx/.azure-for-agent"
    }
  ]
}
```
</details>

<details>
<summary><b>OpenAI-compatible provider examples</b></summary>

```js
{
  "platforms": [
    {
      "name": "openai-compatible",
      "variant": "fireworks",
      "baseURL": "https://api.fireworks.ai/inference",
      "apiKey": "<FIREWORKS_API_KEY>"
    },
    {
      "name": "openai-compatible",
      "variant": "novita",
      "baseURL": "https://api.novita.ai/openai",
      "apiKey": "<NOVITA_API_KEY>"
    }
  ]
}
```

```js
// Ollama example with a custom model
{
  "platforms": [
    {
      "name": "openai-compatible",
      "variant": "ollama",
      "baseURL": "https://ollama.com",
      "apiKey": "<API_KEY>"
    }
  ],
  "models": [
    {
      "name": "gpt-oss",
      "variant": "ollama",
      "platform": {
        "name": "openai-compatible",
        "variant": "ollama"
      },
      "model": {
        "format": "openai-responses",
        "config": {
          "model": "gpt-oss:120b-cloud"
        }
      }
    }
  ]
}
```
</details>

<details>
<summary><b>Bedrock example with Claude Geo Cross-Region inference</b></summary>

```js
{
  "platforms": [
    {
      "name": "bedrock",
      "variant": "jp",
      "baseURL": "https://bedrock-runtime.ap-northeast-1.amazonaws.com",
      "awsProfile": "<AWS_PROFILE>"
    }
  ],
  "models": [
    {
      "name": "claude-haiku-4-5",
      "variant": "thinking-16k-bedrock-jp",
      "platform": {
        "name": "bedrock",
        "variant": "jp"
      },
      "model": {
        "format": "anthropic",
        "config": {
          "model": "jp.anthropic.claude-haiku-4-5-20251001-v1:0",
          "max_tokens": 32768,
          "thinking": { "type": "enabled", "budget_tokens": 16384 }
        }
      },
      "cost": {
        "currency": "USD",
        "unit": "1M",
        "prices": {
          "input_tokens": 1.1,
          "output_tokens": 5.5,
          "cache_read_input_tokens": 0.11,
          "cache_creation_input_tokens": 1.375
        }
      }
    },
    {
      "name": "claude-sonnet-4-6",
      "variant": "thinking-high-bedrock-jp",
      "platform": {
        "name": "bedrock",
        "variant": "jp"
      },
      "model": {
        "format": "anthropic",
        "config": {
          "model": "jp.anthropic.claude-sonnet-4-6",
          "max_tokens": 32768,
          "thinking": { "type": "adaptive" },
          "output_config": { "effort": "high" }
        }
      },
      "cost": {
        "currency": "USD",
        "unit": "1M",
        "prices": {
          "input_tokens": 3.3,
          "output_tokens": 16.5,
          "cache_read_input_tokens": 0.33,
          "cache_creation_input_tokens": 4.125
        }
      }
    }
  ]
}
```
</details>

Run the agent.

```sh
plain

# Or
plain -m <model+variant>
```

Press **Ctrl-C** to pause auto-approval. The agent will finish the current tool call, then return to the prompt.

Show the help message.

```
/help
```

Run in non-interactive batch mode.
In batch mode, configuration files are not loaded automatically. Only the files specified with `-c` are loaded.

```sh
plain batch \
      -c ~/.config/plain-agent/config.local.json \
      -c .plain-agent/config.json \
      "Add tests for ..."
```

Show daily token cost. `plain cost` reads
`~/.local/share/plain-agent/usage.jsonl`; use `--from` / `--to` to set the
period. Costs are shown separately by currency.

```sh
plain cost

# Or
plain cost --from 2026-04-01 --to 2026-04-30
```

Resume a previously interrupted interactive session. Sessions are
automatically saved to `.plain-agent/sessions/` and can be deleted with `rm` when
no longer needed. If no argument is provided, the most recently updated session
is resumed. Use `--list` to see resumable sessions. Switching models is
not supported (`-m` is not allowed).

```sh
plain resume

# Or
plain resume --list
plain resume 2026-05-10-0803-a7k
```

Launch the sandbox command using the app config's sandbox settings.
Arguments before `--` are flags for the `plain` CLI itself (e.g. `-c` to load a
config file). Arguments after `--` are passed through to the sandbox command as-is.

```sh
plain sandbox -- --tty zsh

# Or specify a config file explicitly
plain sandbox -c .plain-agent/config.sandbox.json -- --tty zsh
```

## Configuration

Files are loaded in the following order. Settings in later files override earlier ones.

```
~/.config/plain-agent/
  ├── (1) config.json        # User configuration
  ├── (2) config.local.json  # User local configuration (including secrets)
  ├── prompts/               # Global/User-defined prompts
  └── agents/                # Global/User-defined agent roles

<project-root>
  └── .plain-agent/
        ├── (3) config.json        # Project-specific configuration
        ├── (4) config.local.json  # Project-specific local configuration (including secrets)
        ├── prompts/               # Project-specific prompts
        └── agents/                # Project-specific agent roles
```


<details>
<summary><b>Minimal example (file editing and web search only — no script execution, no sandbox required)</b></summary>

```js
{
  "autoApproval": {
    "defaultAction": "ask",
    "maxApprovals": 100,
    "patterns": [
      {
        "toolName": { "$regex": "^(write_file|patch_file)$" },
        "action": "allow"
      },
      {
        "toolName": { "$regex": "^(web_search|web_fetch)$" },
        "action": "allow"
      }
    ]
  }
}
```

</details>

<details>
<summary><b>YOLO mode example (requires a sandbox for safety)</b></summary>

```js
{
  "autoApproval": {
    // Deny all actions except explicitly allowed
    "defaultAction": "deny",
    "maxApprovals": 100,
    "patterns": [
      {
        "toolName": { "$regex": "^(write_file|patch_file)$" },
        "action": "allow"
      },
      {
        "toolName": { "$regex": "^(web_search|web_fetch)$" },
        "action": "allow"
      },
      {
        "toolName": "exec_command",
        "action": "allow"
      }
      // ⚠️ Never do this. MCP runs outside the sandbox, so it can send anything externally.
      // {
      //   "toolName": { "$regex": "." },
      //   "action": "allow"
      // }
    ]
  },
  "sandbox": {
    "command": "plain-sandbox",
    "args": ["--allow-write", "--mount-readonly", ".plain-agent/config.json", "--keep-alive", "30"],
    // ↑ --mount-readonly: prevents the agent from overwriting its own config
    "separator": "--"
  }
}
```
</details>

<details>
<summary><b>Full example</b></summary>

```js
{
  "autoApproval": {
    // Absolute paths outside the working directory that are allowed. Relative paths are ignored.
    "allowedPaths": ["/path/to/other/git-repo"],
    // Allow access to git-unmanaged files (default: false).
    // ⚠️ Changes to git-unmanaged files are hard to detect (e.g., node_modules). Sandbox is recommended.
    "allowGitUnmanagedFiles": false,
    // Default action when no patterns match. Can be "ask" (prompt user) or "deny" (block action).
    "defaultAction": "ask",
    // Maximum number of automatic approvals.
    "maxApprovals": 50,
    // Patterns are evaluated in order. First match wins.
    "patterns": [
      {
        "toolName": { "$regex": "^(write_file|patch_file)$" },
        "input": { "filePath": { "$regex": "^src/" } },
        "action": "allow"
      },

      // ⚠️ When auto-approving execution, scripts can access unauthorized files and networks. Always use a sandbox.
      {
        "toolName": "exec_command",
        "input": { "command": "npm", "args": ["run", { "$regex": "^(lint|test)$" }] },
        "action": "allow"
      },

      {
        "toolName": { "$regex": "^(web_search|web_fetch)$" },
        "action": "allow"
      },

      // MCP tool naming convention: mcp__<serverName>__<toolName>
      {
        "toolName": { "$regex": "mcp__slack__slack_(read|search)_.+" },
        "action": "allow"
      }
    ],

    // Test cases for verifying patterns. Run: plain test-approval
    "tests": [
      {
        "desc": "npm test should be allowed",
        "toolUse": { "toolName": "exec_command", "input": { "command": "npm", "args": ["run", "test"] } },
        "expectedAction": "allow"
      }
    ]
  },

  "tools": {
    // Enable web tools. See Quick Start section.
    "webSearch": {},
    "webFetch": {},
    // Enable the tmux tool
    "tmux": { "enabled": true }
  },

  // Sandbox environment for the exec_command and tmux_command tools
  "sandbox": {
    // Commands are wrapped and executed with this command
    "command": "plain-sandbox",
    "args": ["--allow-write", "--mount-readonly", ".plain-agent/config.json", "--keep-alive", "30"],
    // ↑ --mount-readonly: prevents the agent from overwriting its own config
    // separator is inserted between sandbox flags and the user command to prevent bypasses
    "separator": "--",

    "rules": [
      // Run specific commands outside the sandbox
      {
        "pattern": {
          "command": { "$regex": "^(gh|docker)$" }
        },
        "mode": "unsandboxed"
      },
      // Run commands in the sandbox with network access
      {
        "pattern": {
          "command": "npm",
          "args": [{ "$regex": "^(install|ci)$" }]
        },
        "mode": "sandbox",
        "additionalArgs": ["--allow-net", "registry.npmjs.org"]
      }
    ]
  },

  // MCP servers
  "mcpServers": {
    "chrome_devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--isolated"]
    },
    // ⚠️ Add this to config.local.json to avoid committing secrets to Git
    "slack": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.slack.com/mcp", "--header", "Authorization:Bearer <SLACK_TOKEN>"],
    },
    "notion": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.notion.com/mcp"],
      "options": {
        // Enable only specific tools. If not specified, all tools are enabled.
        "enabledTools": ["notion-search", "notion-fetch"]
      }
    }
  },

  // Auto-compact: when input tokens exceed the soft limit after a tool execution,
  // the agent is prompted to update the memory file and call compact_context.
  // Reduces noise and token costs before hitting the model's hard limit.
  "autoCompact": {
    "softLimit": 120000,
    // Optional: override per model (prefix match on name+variant)
    "softLimitPerModelPrefix": {
      "gemini-2.5-pro": 500000
    }
  },

  // Override the default notification command
  "notifyCmd": { "command": "plain-notify-desktop", "args": [] }
}
```
</details>

## Available Tools

The agent can use the following tools:

- **read_file**: Read a file with line numbers (1-indexed). Supports `offset` and `limit` to read a specific range.
- **write_file**: Write a file.
- **patch_file**: Patch a file.
- **exec_command**: Run a command without shell interpretation.
- **tmux_command**: Run a tmux command. It is disabled by default.
- **web_search**: Search the web with one or more keyword sets and answer a question based on the combined results (requires Google API key, Vertex AI configuration, or the `command` provider with a local search command).
- **web_fetch**: Fetch the contents of a single URL and answer a question based on it (requires Google API key, Vertex AI configuration, or the `command` provider with a local fetch command such as `w3m`, `curl`, or `lynx`).
- **switch_to_subagent**: Switch to a subagent role within the same conversation, focusing on the specified goal.
- **switch_to_main_agent**: Switch back to the main agent role and report the result. After reporting, the subagent's conversation history is removed from the context.
- **compact_context**: Compact the conversation context by discarding earlier messages and reloading task state from a memory file. Use this when the context has grown large but the task is not yet complete. You can also invoke it with the `/compact` slash command.

## Prompts

You can define reusable prompts in Markdown files.

### Locations

The agent searches for prompts in the following directories:

- `~/.config/plain-agent/prompts/`
- `.plain-agent/prompts/`
- `.plain-agent/prompts/skills/`
- `.claude/commands/`
- `.claude/skills/`

The prompt ID is the relative path of the file without the `.md` extension. For example, `.plain-agent/prompts/commit.md` becomes `/prompts:commit`.

### Prompt File Format

```md
---
description: Create a commit message based on staged changes
---

Review the staged changes and create a concise commit message following the conventional commits specification.
```

### Shortcuts

Prompts located in a `shortcuts/` subdirectory (e.g., `.plain-agent/prompts/shortcuts/commit.md`) can be invoked directly as a top-level command (e.g., `/commit`).

## Subagents

Subagents are specialized helpers for specific tasks.

### Locations

The agent searches for subagent definitions in the following directories:

- `~/.config/plain-agent/agents/`
- `.plain-agent/agents/`
- `.claude/agents/`

### Subagent File Format

```md
---
description: Fetches a web page and answers questions about its content
---

You are a web content reader and analyzer. Given a URL and a question, you:

1. Fetch the page content using `w3m -dump <URL>`.
2. Read and understand the fetched content.
3. Answer the user's question based on the content.
```

## Claude Code Plugin Support

Plugins are installed under `.plain-agent/claude-code-plugins/` and must be installed per project by running `plain install-claude-code-plugins` from the project root. Global installation (e.g., under `~/.plain-agent`) is not supported because plugins may include skills the agent invokes autonomously. Keeping them scoped to the project keeps approval rules and permission management straightforward.

Example:

```js
// .plain-agent/config.json
{
  "claudeCodePlugins": [
    {
      "source": "https://github.com/anthropics/claude-code",
      "plugins": [
        { "name": "feature-dev", "path": "plugins/feature-dev" },
        { "name": "code-review", "path": "plugins/code-review" }
      ]
    },
    {
      "source": "https://github.com/anthropics/skills",
      "plugins": [
        { "name": "document-skills", "path": "", "only": "xlsx|docx|pptx|pdf" }
      ]
    }
  ]
}
```

```sh
plain install-claude-code-plugins
```

## Appendix: Creating Least-Privilege Users for Cloud Providers

<details>
<summary><b>Amazon Bedrock</b></summary>

```sh
# IAM Identity Center
identity_center_instance_arn="<IDENTITY_CENTER_INSTANCE_ARN>" # e.g., arn:aws:sso:::instance/ssoins-xxxxxxxxxxxxxxxx"
identity_store_id=<IDENTITY_STORE_ID>
aws_account_id=<AWS_ACCOUNT_ID>

# Create a permission set
permission_set_arn=$(aws sso-admin create-permission-set \
  --instance-arn "$identity_center_instance_arn" \
  --name "BedrockCodingAgent" \
  --description "Allows only Bedrock model invocation" \
  --query "PermissionSet.PermissionSetArn" --output text)

# Add a policy to the permission set
policy='{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:ListInferenceProfiles"
      ],
      "Resource": [
        "arn:aws:bedrock:*:*:foundation-model/*",
        "arn:aws:bedrock:*:*:inference-profile/*",
        "arn:aws:bedrock:*:*:application-inference-profile/*"
      ]
    }
  ]
}'

aws sso-admin put-inline-policy-to-permission-set \
  --instance-arn "$identity_center_instance_arn" \
  --permission-set-arn "$permission_set_arn" \
  --inline-policy "$policy"

# Create an SSO user
sso_user_name=<SSO_USER_NAME>
sso_user_email=<SSO_USER_EMAIL>
sso_user_family_name=<SSO_USER_FAMILY_NAME>
sso_user_given_name=<SSO_USER_GIVEN_NAME>

user_id=$(aws identitystore create-user \
  --identity-store-id "$identity_store_id" \
  --user-name "$sso_user_name" \
  --display-name "$sso_user_name" \
  --name "FamilyName=${sso_user_family_name},GivenName=${sso_user_given_name}" \
  --emails Value=${sso_user_email},Primary=true \
  --query "UserId" --output text)

# Associate the user, permission set, and account
aws sso-admin create-account-assignment \
  --instance-arn "$identity_center_instance_arn" \
  --target-id "$aws_account_id" \
  --target-type AWS_ACCOUNT \
  --permission-set-arn "$permission_set_arn" \
  --principal-type USER \
  --principal-id "$user_id"

# Verify the setup
aws configure sso
# profile: CodingAgent

profile=CodingAgent
aws sso login --profile "$profile"

echo '{"anthropic_version": "bedrock-2023-05-31", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}' > request.json

aws bedrock-runtime invoke-model \
  --model-id global.anthropic.claude-haiku-4-5-20251001-v1:0 \
  --body fileb://request.json \
  --profile "$profile" \
  --region ap-northeast-1 \
  response.json
```
</details>

<details>
<summary><b>Azure - Microsoft Foundry</b></summary>

```sh
resource_group=<RESOURCE_GROUP>
account_name=<ACCOUNT_NAME> # Resource name

# Create a service principal
service_principal=$(az ad sp create-for-rbac --name "CodingAgentServicePrincipal" --skip-assignment)
echo "$service_principal"
app_id=$(echo "$service_principal" | jq -r .appId)

# Assign role permissions
# https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/role-based-access-control?view=foundry-classic#azure-openai-roles
resource_id=$(az cognitiveservices account show \
    --name "$account_name" \
    --resource-group "$resource_group" \
    --query id --output tsv)

az role assignment create \
  --role "Cognitive Services OpenAI User" \
  --assignee "$app_id" \
  --scope "$resource_id"

# Log in with the service principal
export app_secret=$(echo "$service_principal" | jq -r .password)
export tenant_id=$(echo "$service_principal" | jq -r .tenant)

export AZURE_CONFIG_DIR=$HOME/.azure-for-agent # Change this to store credentials elsewhere
az login --service-principal -u "$app_id" -p "$app_secret" --tenant "$tenant_id"
```
</details>

<details>
<summary><b>Google Cloud Vertex AI</b></summary>

```sh
project_id=<PROJECT_ID>
service_account_name=<SERVICE_ACCOUNT_NAME>
service_account_email="${service_account_name}@${project_id}.iam.gserviceaccount.com"
your_account_email=<YOUR_ACCOUNT_EMAIL>

# Create a service account
gcloud iam service-accounts create "$service_account_name" \
  --project "$project_id" --display-name "Vertex AI Caller Service Account for Coding Agent"

# Grant permissions
gcloud projects add-iam-policy-binding "$project_id" \
  --member "serviceAccount:$service_account_email" \
  --role="roles/aiplatform.serviceAgent"

# Allow your account to impersonate the service account
gcloud iam service-accounts add-iam-policy-binding "$service_account_email" \
  --project "$project_id" \
  --member "user:$your_account_email" \
  --role "roles/iam.serviceAccountTokenCreator"

# Verify that tokens can be issued
gcloud auth print-access-token --impersonate-service-account "$service_account_email"
```
</details>

## Developer Notes

<details>
<summary>Release</summary>

```sh
npm version <major|minor|patch>

git push --follow-tags
gh release create $(git describe --tags) --generate-notes

npm publish --access public
```
</details>

