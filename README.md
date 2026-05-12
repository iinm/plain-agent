# Plain Agent

A lightweight, capable coding agent for the terminal.

- **Multi-provider** — Use Claude, GPT, Gemini, or any OpenAI-compatible model.
  <details>
  <summary>Predefined models</summary>
  
  ```
  # Model+Variant (Platform+Variant)
  claude-haiku-4-5+thinking-16k (platform: anthropic+default)
  claude-haiku-4-5+thinking-32k (platform: anthropic+default)
  claude-sonnet-4-6+thinking-high (platform: anthropic+default)
  claude-sonnet-4-6+thinking-max (platform: anthropic+default)
  claude-opus-4-7+thinking-high (platform: anthropic+default)
  claude-opus-4-7+thinking-max (platform: anthropic+default)
  claude-haiku-4-5+thinking-16k-bedrock (platform: bedrock+default)
  claude-haiku-4-5+thinking-32k-bedrock (platform: bedrock+default)
  claude-sonnet-4-6+thinking-high-bedrock (platform: bedrock+default)
  claude-sonnet-4-6+thinking-max-bedrock (platform: bedrock+default)
  claude-opus-4-7+thinking-high-bedrock (platform: bedrock+default)
  claude-opus-4-7+thinking-max-bedrock (platform: bedrock+default)
  gemini-3-flash-preview+thinking-medium (platform: gemini+default)
  gemini-3-flash-preview+thinking-high (platform: gemini+default)
  gemini-3.1-pro-preview+thinking-medium (platform: gemini+default)
  gemini-3.1-pro-preview+thinking-high (platform: gemini+default)
  gemini-3-flash-preview+thinking-medium-vertex-ai (platform: vertex-ai+default)
  gemini-3-flash-preview+thinking-high-vertex-ai (platform: vertex-ai+default)
  gemini-3.1-pro-preview+thinking-medium-vertex-ai (platform: vertex-ai+default)
  gemini-3.1-pro-preview+thinking-high-vertex-ai (platform: vertex-ai+default)
  gpt-5.4-mini+thinking-medium (platform: openai+default)
  gpt-5.4-mini+thinking-high (platform: openai+default)
  gpt-5.4-mini+thinking-xhigh (platform: openai+default)
  gpt-5.5+thinking-medium (platform: openai+default)
  gpt-5.5+thinking-high (platform: openai+default)
  gpt-5.5+thinking-xhigh (platform: openai+default)
  gpt-5.2-chat+thinking-medium-azure (platform: azure+openai)
  gpt-oss-120b+fireworks (platform: openai-compatible+fireworks)
  glm-5+vertex-ai (platform: vertex-ai+default)
  glm-5.1+fireworks (platform: openai-compatible+fireworks)
  glm-5.1+novita (platform: openai-compatible+novita)
  kimi-k2.6+fireworks (platform: openai-compatible+fireworks)
  kimi-k2.6+novita (platform: openai-compatible+novita)
  deepseek-v4-pro+novita (platform: openai-compatible+novita)
  deepseek-v4-pro+fireworks (platform: openai-compatible+fireworks)
  minimax-m2.7+fireworks (platform: openai-compatible+fireworks)
  minimax-m2.7+novita (platform: openai-compatible+novita)
  qwen3.6-plus+fireworks (platform: openai-compatible+fireworks)
  qwen3.6-27b+novita (platform: openai-compatible+novita)
  nova-2-lite+bedrock (platform: bedrock+default)
  claude-haiku-4-5+thinking-16k-bedrock-converse (platform: bedrock+default)
  ```
  </details>


- **Approval rules & path validation** — Auto-approve tool uses by name and arguments using regex patterns ([config.predefined.json#autoApproval](https://github.com/iinm/plain-agent/blob/main/config/config.predefined.json)); restrict file access to the working directory — git-ignored files require explicit approval ([src/toolInputValidator.mjs](https://github.com/iinm/plain-agent/blob/main/src/toolInputValidator.mjs)).
- **Sandboxed execution** — Run agent commands in a Docker container with a read-only project root and no network; writable mode and allowlisted network destinations can be enabled as needed.
- **Plain-text memory** — Task state is saved as Markdown files under `.plain-agent/memory/` for easy review.
- **Extensible** — Define prompts and subagents in Markdown. Connect MCP servers.
  Supports Claude Code plugins and `.claude/` commands, subagents, and skills.

## Limitations

- **Path validation only covers tool arguments** — Path validation restricts only paths explicitly passed as tool-use arguments; it cannot control file access inside arbitrary scripts. Always use sandboxed execution when allowing arbitrary script execution.
- **Sequential subagent execution** — Subagents run one at a time rather than
  in parallel. The trade-off is full visibility: every step is streamed to
  your terminal so you can follow exactly what each subagent is doing.

## Requirements

- Node.js 22 or later
- LLM provider credentials
- [ripgrep](https://github.com/burntsushi/ripgrep), [fd](https://github.com/sharkdp/fd)
- Bash / Docker for sandboxed execution

## Quick Start

```sh
npm install -g @iinm/plain-agent
```

List available models.

```sh
plain list-models
```

Create the configuration.

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

  // (Optional) Enable web tools
  "tools": {
    "webSearch": {
      "provider": "gemini",
      "apiKey": "<GEMINI_API_KEY>",
      "model": "gemini-3-flash-preview"

      // Or use Vertex AI (Requires gcloud CLI to get authentication token)
      // "provider": "gemini-vertex-ai",
      // "baseURL": "https://aiplatform.googleapis.com/v1beta1/projects/<project_id>/locations/<location>",
      // "model": "gemini-3-flash-preview"

      // Or run a local search command per search (each search's `keywords` are
      // appended to `args`) and let the agent's main model filter the combined results.
      // The example below uses w3m + DuckDuckGo (`$*` joins all keywords; `-o display_link_number=1` shows link URLs):
      // "provider": "command",
      // "command": "bash",
      // "args": ["-c", "w3m -dump -o display_link_number=1 \"https://duckduckgo.com/lite/?q=$*\"", "ddg"],
      // (Optional) Per-search timeout in milliseconds. Default 30000.
      // "timeoutMs": 30000,
      // (Optional) Extra env vars merged on top of PATH / HOME / LANG.
      // "env": { "NO_COLOR": "1" },
      // (Optional) Cap the result size (in characters) to keep prompts small. Defaults shown.
      // "maxLengthPerSearch": 50000,
      // "maxTotalLength": 200000
    },

    "webFetch": {
      "provider": "gemini",
      "apiKey": "<GEMINI_API_KEY>",
      "model": "gemini-3-flash-preview"

      // Or use Vertex AI (Requires gcloud CLI to get authentication token)

      // Or fetch the URL locally with an arbitrary command (the URL is appended
      // to `args`) and answer using the agent's main model. `-o display_link_number=1`
      // makes w3m print link URLs alongside text:
      // "provider": "command",
      // "command": "w3m",
      // "args": ["-dump", "-o", "display_link_number=1"],
      // (Optional) Per-call timeout in milliseconds. Default 30000.
      // "timeoutMs": 30000,
      // (Optional) Extra env vars merged on top of PATH / HOME / LANG.
      // "env": { "NO_COLOR": "1" },
      // (Optional) Cap the fetched content size (in characters) to keep prompts small. Default 200000.
      // "maxLength": 200000
    }
  }
}
```

<details>
<summary><b>Azure / Bedrock / Vertex AI provider examples</b></summary>

```js
{
  "platforms": [
    {
      // Requires Azure CLI to get access token
      "name": "azure",
      "variant": "openai",
      "baseURL": "https://<resource>.openai.azure.com/openai",
      // Optional
      "azureConfigDir": "/home/xxx/.azure-for-agent"
    },
    {
      // Requires AWS CLI to get credentials
      "name": "bedrock",
      "variant": "default",
      "baseURL": "https://bedrock-runtime.<region>.amazonaws.com",
      "awsProfile": "<AWS_PROFILE>"
    },
    {
      // Requires gcloud CLI to get authentication token
      "name": "vertex-ai",
      "variant": "default",
      "baseURL": "https://aiplatform.googleapis.com/v1beta1/projects/<project>/locations/<location>",
      // (Optional) Impersonate this service account to obtain an auth token
      "account": "<SERVICE_ACCOUNT_EMAIL>"
    }
  ]
}
```
</details>

<details>
<summary><b>OpenAI compatible provider examples</b></summary>

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
<summary><b>Bedrock example using Claude Japan inference profiles</b></summary>

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
        "costs": {
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
        "costs": {
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
```

```
plain -m <model+variant>
```

Press **Ctrl-C** to pause auto-approve. The agent will finish the current tool call, then return to the prompt.

Display the help message.

```
/help
```

Run in batch mode (non-interactive).
In batch mode, config files are not loaded automatically. Only the files specified with `-c` are loaded.

```sh
plain batch \
      -c ~/.config/plain-agent/config.local.json \
      -c .plain-agent/config.json \
      "Add tests for ..."
```

Show daily token costs across sessions. `plain cost` reads
`~/.local/share/plain-agent/usage.jsonl`; use `--from` / `--to` to set the
period. Currencies are shown separately.

```sh
plain cost
```

```
plain cost --from 2026-04-01 --to 2026-04-30
```

Resume a previously interrupted interactive session. Sessions are
auto-saved to `.plain-agent/sessions/` and can be removed with `rm` when
no longer needed. Without an argument, the most recently updated session
is resumed. Use `--list` to see resumable sessions. Switching models is
not supported (`-m` is rejected).

```sh
plain resume
```

```
plain resume --list
plain resume 2026-05-10-0803-a7k
```

Configure plain-agent for your project.

```
/configure Auto-approve file writes and patches
```

```
/configure Set up a sandbox for this project
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
        ├── agents/                # Project-specific agent roles
        └── sandbox/               # Sandbox runner scripts
```

### Example

<details>
<summary><b>YOLO mode example (requires sandbox for safety)</b></summary>

```js
{
  "autoApproval": {
    "defaultAction": "deny",
    "maxApprovals": 100,
    "patterns": [
      {
        "toolName": { "$regex": "^(write_file|patch_file)$" },
        "action": "allow"
      },
      {
        "toolName": { "$regex": "^(exec_command|tmux_command)$" },
        "action": "allow"
      },
      {
        "toolName": { "$regex": "^(web_search|web_fetch)$" },
        "action": "allow"
      }
      // ⚠️ Never do this. mcp run outside the sandbox, so they can send anything externally.
      // {
      //   "toolName": { "$regex": "." },
      //   "action": "allow"
      // }
    ]
  },
  "sandbox": {
    "command": "plain-sandbox",
    "args": ["--allow-write", "--skip-build", "--keep-alive", "30"],
    "separator": "--",
    "rules": [
      {
        "pattern": {
          "command": "npm",
          "args": ["ci"]
        },
        "mode": "sandbox",
        "extraArgs": ["--allow-net", "0.0.0.0/0"]
      }
    ]
  }
}
```
</details>

<details>
<summary><b>Full example</b></summary>

```js
{
  "autoApproval": {
    "defaultAction": "ask",
    // The maximum number of automatic approvals.
    "maxApprovals": 50,
    // Patterns are evaluated in order. First match wins.
    "patterns": [
      {
        "toolName": { "$regex": "^(write_file|patch_file)$" },
        "input": { "filePath": { "$regex": "^\\.plain-agent/memory/.+\\.md$" } },
        "action": "allow"
      },
      {
        "toolName": { "$regex": "^(write_file|patch_file)$" },
        "input": { "filePath": { "$regex": "^src/" } },
        "action": "allow"
      },

      // ⚠️ Arbitrary code execution can access unauthorized files and networks. Always use a sandbox.
      {
        "toolName": "exec_command",
        "input": { "command": "npm", "args": ["run", { "$regex": "^(lint|test)$" }] },
        "action": "allow"
      },

      {
        "toolName": { "$regex": "^(web_search|web_fetch)$" },
        "action": "allow"
      },

      // MCP Tool naming convention: mcp__<serverName>__<toolName>
      {
        "toolName": { "$regex": "mcp__slack__slack_(read|search)_.+" },
        "action": "allow"
      }
    ]
  },

  // Sandbox environment for the exec_command and tmux_command tools
  "sandbox": {
    "command": "plain-sandbox",
    "args": ["--allow-write", "--skip-build", "--keep-alive", "30"],
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
          "args": ["install"]
        },
        "mode": "sandbox",
        // Allow access to registry.npmjs.org
        "additionalArgs": ["--allow-net", "registry.npmjs.org"]
      }
    ]
  },

  // Configure MCP servers
  "mcpServers": {
    "chrome_devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--isolated"]
    },
    // ⚠️ Add to config.local.json to avoid committing secrets to Git
    "slack": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.slack.com/mcp", "--header", "Authorization:Bearer <SLACK_TOKEN>"],
    },
    "notion": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.notion.com/mcp"],
      "options": {
        // Enable only specific tools (optional - if not specified, all tools are enabled)
        "enabledTools": ["notion-search", "notion-fetch"]
      }
    },
    "aws_knowledge": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://knowledge-mcp.global.api.aws"]
    },
    // ⚠️ Add to config.local.json to avoid committing secrets to Git
    "google_developer-knowledge": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://developerknowledge.googleapis.com/mcp", "--header", "X-Goog-Api-Key:<GOOGLE_API_KEY>"]
    }
  },

  // Override default notification command
  "notifyCmd": { "command": "plain-notify-desktop", "args": [] }

  // Voice input. See "Voice Input" below.
  // ⚠️ Add to config.local.json to avoid committing secrets to Git
  "voiceInput": {
    "provider": "openai",
    "apiKey": "<OPENAI_API_KEY>"
  }
}
```
</details>

## Available Tools

The agent can use the following tools to assist with tasks:

- **read_file**: Read a file with line numbers (1-indexed). Supports `offset` and `limit` to read a specific range.
- **write_file**: Write a file.
- **patch_file**: Patch a file.
- **exec_command**: Run a command without shell interpretation.
- **tmux_command**: Run a tmux command.
- **web_search**: Search the web with one or more keyword sets and answer a question based on the combined results (requires Google API key, Vertex AI configuration, or the `command` provider with a local search command).
- **web_fetch**: Fetch the contents of a single URL and answer a question based on it (requires Google API key, Vertex AI configuration, or the `command` provider with a local fetch command such as `w3m`, `curl`, or `lynx`).
- **switch_to_subagent**: Switch to a subagent role within the same conversation, focusing on the specified goal.
- **switch_to_main_agent**: Switch back to the main agent role and report the result. After reporting, the subagent's conversation history is removed from the context.
- **compact_context**: Compact the conversation context by discarding prior messages and reloading task state from a memory file. Use when the context has grown large but the task is not yet complete. Can also be invoked via the `/compact` slash command.

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

Subagents are specialized agents designed for specific tasks.

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

Plugins are installed under `.plain-agent/claude-code-plugins/` and must be
installed per project by running `plain install-claude-code-plugins` from
the project root. Global installation (e.g., under `~/.plain-agent`) is not
supported, because plugins may include skills that the agent invokes
autonomously, and scoping them to the project keeps approval rules and
permission management straightforward.

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

## Voice Input

Press **Ctrl-O** to start recording, press it again to stop. Partial
transcripts are inserted into the prompt as you speak so you can edit
and send them like regular text.

### Requirements

- A recording command on `PATH`: `arecord`, `sox`, or `ffmpeg`.
- An API key for the chosen provider.
- Your host must have microphone access. The sandbox does not need to.

### Providers

**OpenAI Realtime**

```js
// ~/.config/plain-agent/config.local.json
{
  "voiceInput": {
    "provider": "openai",
    "apiKey": "<OPENAI_API_KEY>"
    // "model": "gpt-4o-transcribe",  // or "gpt-4o-mini-transcribe", "whisper-1"
    // "language": "ja"               // ISO-639-1 code. Improves accuracy and latency.
  }
}
```

**Gemini Live**

```js
// ~/.config/plain-agent/config.local.json
{
  "voiceInput": {
    "provider": "gemini",
    "apiKey": "<GEMINI_API_KEY>"
    // "model": "gemini-3.1-flash-live-preview",
    // "language": "ja"
  }
}
```

### Options

- `toggleKey` — Rebind the toggle. Accepts `"ctrl-<char>"` where `<char>`
  is a letter (a-z) or one of `[ \ ] ^ _`. Defaults to `"ctrl-o"`.
- `recorder` — Override recorder auto-detection, e.g. `{ "command": "sox", "args": ["-q", "-d", "-b", "16", "-c", "1", "-r", "24000", "-e", "signed-integer", "-t", "raw", "-"] }`. Must write raw 16-bit little-endian mono PCM to stdout at 24 kHz (OpenAI) or 16 kHz (Gemini).

## Development

```sh
# Run lint, typecheck, and test
npm run check

# Fix lint errors
npm run fix
# or
npm run fix -- --unsafe

# Update dependencies
npx npm-check-updates -t minor -c 3
npx npm-check-updates -t minor -c 3 -u
```

## Release

```sh
npm version <major|minor|patch>

git push --follow-tags
gh release create $(git describe --tags) --generate-notes

npm publish --access public
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
  --name "BedrockForCodingAgent" \
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
account_name=<ACCOUNT_NAME> # resource name

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

export AZURE_CONFIG_DIR=$HOME/.azure-for-agent # Change the location to store credentials
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
