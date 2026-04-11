# Plain Agent

A lightweight CLI-based coding agent.

- **Safety controls** — Configure approval rules and sandboxing for safe execution
- **Multi-provider** — Supports Anthropic, OpenAI, Gemini, Bedrock, Azure, Vertex AI, and more
- **Sequential subagent delegation** — Delegate subtasks to specialized subagents with full visibility
- **MCP support** — Connect to external MCP servers to extend available tools
- **Claude Code compatible** — Reuse Claude Code plugins, agents, commands, and skills

## Safety Controls

**Auto-Approval**: Tools with no side effects and no sensitive data access are automatically approved based on patterns defined in [`config.predefined.json#autoApproval`](https://github.com/iinm/plain-agent/blob/main/.config/config.predefined.json).

**Path Validation**: All file paths in tool inputs are validated to remain within the working directory and under git control.

⚠️ `write_file` and `patch_file` require explicit path arguments. However, `exec_command` can run arbitrary code where file access cannot be validated. Use a sandbox for stronger isolation.

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
  // "model": "claude-sonnet-4-6+thinking-16k",

  // Configure the providers you want to use
  "platforms": [
    {
      "name": "anthropic",
      "variant": "default",
      "apiKey": "FIXME"
      // Or
      // "apiKey": { "$env": "ANTHROPIC_API_KEY" }
    },
    {
      "name": "gemini",
      "variant": "default",
      "apiKey": "FIXME"
    },
    {
      "name": "openai",
      "variant": "default",
      "apiKey": "FIXME"
    },
    {
      // Requires Azure CLI to get access token
      "name": "azure",
      "variant": "default",
      "baseURL": "https://<resource>.openai.azure.com/openai",
      // Optional
      "azureConfigDir": "/home/xxx/.azure-for-agent"
    },
    {
      "name": "bedrock",
      "variant": "default",
      "baseURL": "https://bedrock-runtime.<region>.amazonaws.com",
      "awsProfile": "FIXME"
    },
    {
      // Requires gcloud CLI to get authentication token
      "name": "vertex-ai",
      "variant": "default",
      "baseURL": "https://aiplatform.googleapis.com/v1beta1/projects/<project>/locations/<location>",
      // Optional
      "account": "<service_account_email>"
    }
  ],

  // Optional
  "tools": {
    "askWeb": {
      "provider": "gemini",
      "apiKey": "FIXME",
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

    "askURL": {
      "provider": "gemini",
      "apiKey": "FIXME"
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
<summary><b>Other provider examples</b></summary>

```js
{
  "platforms": [
    {
      "name": "openai",
      "variant": "ollama",
      "baseURL": "https://ollama.com",
      "apiKey": "FIXME"
    },
    {
      "name": "openai",
      "variant": "huggingface",
      "baseURL": "https://router.huggingface.co",
      "apiKey": "FIXME"
    },
    {
      "name": "openai",
      "variant": "xai",
      "apiKey": "FIXME"
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
      "variant": "thinking-16k-bedrock-jp",
      "platform": {
        "name": "bedrock",
        "variant": "jp"
      },
      "model": {
        "format": "anthropic",
        "config": {
          "model": "jp.anthropic.claude-sonnet-4-6",
          "max_tokens": 32768,
          "thinking": { "type": "enabled", "budget_tokens": 16384 }
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
      "awsProfile": "FIXME"
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
    "args": ["--dockerfile", ".plain-agent/sandbox/Dockerfile", "--allow-write", "--skip-build", "--keep-alive", "30"],
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
    "args": ["--dockerfile", ".plain-agent/sandbox/Dockerfile", "--allow-write", "--skip-build", "--keep-alive", "30"],
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
      "args": ["-y", "mcp-remote", "https://mcp.slack.com/mcp", "--header", "Authorization:Bearer FIXME"],
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
      "args": ["-y", "mcp-remote", "https://developerknowledge.googleapis.com/mcp", "--header", "X-Goog-Api-Key:FIXME"]
    }
  },

  // Override default notification command
  // "notifyCmd": "/path/to/notification-command"
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
identity_center_instance_arn="FIXME" # e.g., arn:aws:sso:::instance/ssoins-xxxxxxxxxxxxxxxx"
identity_store_id=FIXME
aws_account_id=FIXME

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
sso_user_name=FIXME
sso_user_email=FIXME
sso_user_family_name=FIXME
sso_user_given_name=FIXME

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
resource_group=FIXME
account_name=FIXME # resource name

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
project_id=FIXME
service_account_name=FIXME
service_account_email="${service_account_name}@${project_id}.iam.gserviceaccount.com"
your_account_email=FIXME

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
