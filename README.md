<p align="center">
  <img src="https://pub-0bb49aa929f242d49c89ed8c297932b5.r2.dev/plain-agent/plain-agent-logo.png" alt="plain-agent logo" width="320">
</p>

# Plain Agent

A lightweight CLI-based coding agent with zero framework dependencies.

## Why Plain Agent?

- **Multi-provider** — Use Claude, GPT, Gemini, or any OpenAI-compatible model.
  Switch providers without changing your workflow.
- **Fine-grained approval rules** — Auto-approve commands by name, arguments,
  and file paths using regex patterns
  ([`config.predefined.json`](https://github.com/iinm/plain-agent/blob/main/config/config.predefined.json)).
- **Path validation** — File paths must stay within the working directory
  and git-ignored files (`.env`, etc.) are blocked.
- **Sandboxed execution** — Run the agent's shell commands inside a Docker
  container with network access restricted to allowlisted destinations
  (e.g., `registry.npmjs.org` only for `npm install`).
- **Extensible** — Define prompts and subagents in Markdown.
  Connect MCP servers. Reuse Claude Code plugins.

## Limitations

- **Sequential subagent execution** — Subagents run one at a time rather than
  in parallel. The trade-off is full visibility: every step is streamed to
  your terminal so you can follow exactly what each subagent is doing.

## Requirements

- Node.js 22 or later
- LLM provider credentials
- bash / docker for sandboxed execution
- [ripgrep](https://github.com/burntsushi/ripgrep)
- [fd](https://github.com/sharkdp/fd)

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
  "model": "gpt-5.4+thinking-high",
  // "model": "claude-sonnet-4-6+thinking-high",

  // Configure the providers you want to use
  "platforms": [
    {
      "name": "anthropic",
      "variant": "default",
      "apiKey": "<ANTHROPIC_API_KEY>"
      // Or
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
    },
  ],

  // Optional
  "tools": {
    // askWeb: Searches the web to answer questions requiring up-to-date information or external sources.
    "askWeb": {
      "provider": "gemini",
      "apiKey": "<GEMINI_API_KEY>",
      "model": "gemini-3-flash-preview"
      // Optional
      // "baseURL": "<proxy_url>"

      // Or use Vertex AI (Requires gcloud CLI to get authentication token)
      // "provider": "gemini-vertex-ai",
      // "baseURL": "https://aiplatform.googleapis.com/v1beta1/projects/<project_id>/locations/<location>",
      // "model": "gemini-3-flash-preview"
      // Optional:
      // "account": "<service_account_email>"
    },

    // askURL: Answers questions based on provided URL content.
    //         Directly injecting URL content into context is not supported to prevent prompt injection.
    "askURL": {
      "provider": "gemini",
      "apiKey": "<GEMINI_API_KEY>"
      "model": "gemini-3-flash-preview"
      // Optional
      // "baseURL": "<proxy_url>"

      // Or use Vertex AI (Requires gcloud CLI to get authentication token)
      // "provider": "gemini-vertex-ai",
      // "baseURL": "https://aiplatform.googleapis.com/v1beta1/projects/<project_id>/locations/<location>",
      // "model": "gemini-3-flash-preview"
      // Optional:
      // "account": "<service_account_email>"
    }
  },

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
      // Optional
      "account": "<service_account_email>"
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
      "variant": "ollama",
      "baseURL": "https://ollama.com",
      "apiKey": "<API_KEY>"
    },
    {
      "name": "openai-compatible",
      "variant": "huggingface",
      "baseURL": "https://router.huggingface.co",
      "apiKey": "<HUGGINGFACE_API_KEY>"
    },
    {
      "name": "openai-compatible",
      "variant": "fireworks",
      "baseURL": "https://api.fireworks.ai/inference",
      "apiKey": "<FIREWORKS_API_KEY>"
    }
  ]
}
```
</details>

<details>
<summary><b>Bedrock example using Claude Japan inference profiles</b></summary>

```js
{
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
  ],
  "platforms": [
    {
      "name": "bedrock",
      "variant": "jp",
      "baseURL": "https://bedrock-runtime.ap-northeast-1.amazonaws.com",
      "awsProfile": "<AWS_PROFILE>"
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

(Optional) Set up a sandbox for your project with the `sandbox-configurator` agent.

```
/agents:sandbox-configurator Set up a sandbox for this project
```

After the agent finishes, run the generated setup script once to build the sandbox image and install dependencies.

```sh
./.plain-agent/setup.sh
```

Run in batch mode (non-interactive).
In batch mode, config files are not loaded automatically. Only the files specified with `--config` are loaded.

```sh
plain batch \
      -c ~/.config/plain-agent/config.local.json \
      -c .plain-agent/config.json \
      "Add tests for ..."
```

Display the help message.

```
/help
```

Interrupt the agent while it's running:

Press **Ctrl-C** to pause auto-approve. The agent will finish the current tool call, then return to the prompt.

## Available Tools

The agent can use the following tools to assist with tasks:

- **exec_command**: Run a command without shell interpretation.
- **write_file**: Write a file.
- **patch_file**: Patch a file.
- **tmux_command**: Run a tmux command.
- **ask_web**: Use the web search to answer questions that need up-to-date information or supporting sources. (requires Google API key or Vertex AI configuration).
- **ask_url**: Use one or more provided URLs to answer a question. Include the URLs in your question. (requires Google API key or Vertex AI configuration).
- **delegate_to_subagent**: Delegate a subtask to a subagent. The agent switches to a subagent role within the same conversation, focusing on the specified goal.
- **report_as_subagent**: Report completion and return to the main agent. Used by subagents to communicate results and restore the main agent role. After reporting, the subagent's conversation history is removed from the context.
- **compact_context**: Compact the conversation context by discarding prior messages and reloading task state from a memory file. Use when the context has grown large but the task is not yet complete. Can also be invoked via the `/compact` slash command.

## Directory Structure

```
~/.config/plain-agent/
  \__ config.json        # User configuration
  \__ config.local.json  # User local configuration (including secrets)
  \__ prompts/           # Global/User-defined prompts
  \__ agents/            # Global/User-defined agent roles

<project-root>
  \__ .plain-agent/
        \__ config.json            # Project-specific configuration
        \__ config.local.json      # Project-specific local configuration (including secrets)
        \__ memory/                # Task-specific memory files
        \__ prompts/               # Project-specific prompts
        \__ agents/                # Project-specific agent roles
```

## Configuration

The agent loads configuration files in the following order. Settings in later files will override those in earlier files.

- `~/.config/plain-agent/config.json`: User configuration for all projects.
- `~/.config/plain-agent/config.local.json`: User local configuration, typically for API keys.
- `.plain-agent/config.json`: Project-specific configuration.
- `.plain-agent/config.local.json`: Project-specific local configuration, typically for API keys or local development overrides.

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
        "toolName": { "$regex": "^(ask_web|ask_url)$" },
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
        "input": { "filePath": { "$regex": "^(\\./)?\\.plain-agent/memory/.+\\.md$" } },
        "action": "allow"
      },
      {
        "toolName": { "$regex": "^(write_file|patch_file)$" },
        "input": { "filePath": { "$regex": "^(\\./)?src/" } },
        "action": "allow"
      },

      // ⚠️ Arbitrary code execution can access unauthorized files and networks. Always use a sandbox.
      {
        "toolName": "exec_command",
        "input": { "command": "npm", "args": ["run", { "$regex": "^(check|test|lint|fix)$" }] },
        "action": "allow"
      },

      {
        "toolName": { "$regex": "^(ask_web|ask_url)$" },
        "action": "allow"
      },

      // MCP Tool naming convention: mcp__<serverName>__<toolName>
      {
        "toolName": { "$regex": "slack_(read|search)_.+" },
        "action": "allow"
      }
    ]
  },

  // (Optional) Sandbox environment for the exec_command and tmux_command tools
  // https://github.com/iinm/plain-agent/tree/main/sandbox
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
    // ⚠️ Add this to config.local.json to avoid committing secrets to Git
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
    // ⚠️ Add this to config.local.json to avoid committing secrets to Git
    "google_developer-knowledge": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://developerknowledge.googleapis.com/mcp", "--header", "X-Goog-Api-Key:<GOOGLE_API_KEY>"]
    }
  },

  // Override default notification command
  // "notifyCmd": "/path/to/notification-command"

  // (Optional) Voice input. See "Voice Input" below.
  // "voiceInput": {
  //   "provider": "openai",
  //   "apiKey": "<OPENAI_API_KEY>"
  // }
}
```
</details>

## Prompts

You can define reusable prompts in Markdown files.

### Prompt File Format

```md
---
description: Create a commit message based on staged changes
---

Review the staged changes and create a concise commit message following the conventional commits specification.
```

You can also import remote prompts with the `import` field:

```md
---
import: https://raw.githubusercontent.com/anthropics/claude-code/5cff78741f54a0dcfaeb11d29b9ea9a83f3882ff/plugins/feature-dev/commands/feature-dev.md
---

- Use memory file instead of TodoWrite
- Parallel execution of subagents is not supported. Delegate to subagents sequentially.
```

```md
---
import: https://raw.githubusercontent.com/anthropics/claude-code/db8834ba1d72e9a26fba30ac85f3bc4316bb0689/plugins/code-review/commands/code-review.md
---

- Parallel execution of subagents is not supported. Delegate to subagents sequentially.
- If CLAUDE.md is not found, refer to AGENTS.md instead for project rules and conventions.
- If the PR branch is already checked out, review changes from local files instead of fetching from GitHub.
- After explaining the review results to the user, ask whether to post the comments to GitHub as well.
```

Remote prompts are fetched and cached locally. The local content will be appended to the imported content.

### Locations

The agent searches for prompts in the following directories:

- `~/.config/plain-agent/prompts/`
- `.plain-agent/prompts/`
- `.claude/commands/`
- `.claude/skills/`

The prompt ID is the relative path of the file without the `.md` extension. For example, `.plain-agent/prompts/commit.md` becomes `/prompts:commit`.

### Shortcuts

Prompts located in a `shortcuts/` subdirectory (e.g., `.plain-agent/prompts/shortcuts/commit.md`) can be invoked directly as a top-level command (e.g., `/commit`).

## Subagents

Subagents are specialized agents designed for specific tasks.

### Subagent File Format

```md
---
description: Simplifies and refines code for clarity and maintainability
---

You are a code simplifier. Your role is to refactor code while preserving its functionality.
```

You can also import remote subagent definitions with the `import` field:

```md
---
import: https://raw.githubusercontent.com/anthropics/claude-code/f7ab5c799caf2ec8c7cd1b99d2bc2f158459ef5e/plugins/pr-review-toolkit/agents/code-simplifier.md
---

Use AGENTS.md instead of CLAUDE.md in this project.
```

Remote subagents are fetched and cached locally. The local content will be appended to the imported content.

### Locations

The agent searches for subagent definitions in the following directories:

- `~/.config/plain-agent/agents/`
- `.plain-agent/agents/`
- `.claude/agents/`

## Claude Code Plugin Support

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

**OpenAI Realtime** (default, recommended):

```js
{
  "voiceInput": {
    "provider": "openai",
    "apiKey": "<OPENAI_API_KEY>"
    // "model": "gpt-4o-transcribe",  // or "gpt-4o-mini-transcribe", "whisper-1"
    // "language": "ja"               // ISO-639-1 code. Improves accuracy and latency.
  }
}
```

**Gemini Live** (preview API; model names and pricing may change):

```js
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
- `recorder` — Override recorder auto-detection. Must write raw 16-bit
  little-endian mono PCM to stdout at 24 kHz (OpenAI) or 16 kHz (Gemini).

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
npm run check

git commit -m "<message>"

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
