---
description: Update plain-agent configuration based on user needs.
---

Fetch the latest README and help the user configure plain-agent for this project. Before each step, briefly explain to the user what you are about to do and why.

## Security Rule (Non-Negotiable)

**Never write credentials** (API keys, tokens, passwords, secrets) into any config file.

When a setting requires a credential:
1. Tell the user it must go into `.plain-agent/config.local.json`.
2. Show the exact JSON snippet they need to add.
3. Do not modify that file yourself.

If the user wants a setting applied globally (`~/.config/plain-agent/`), show them the exact snippet and tell them to add it manually. Do not access the home directory.

## Step 1: Fetch the Latest README

Fetch the latest README from GitHub as the authoritative reference for all configuration options:

```sh
gh api --method GET -H "Accept: application/vnd.github.v3.raw" "repos/iinm/plain-agent/contents/README.md?ref=main"
```

## Step 2: Read the Current Config

```sh
cat .plain-agent/config.json
```

## Step 3: Ask the User What They Want

Ask what the user wants to configure. Common topics:

- **Model** — which LLM to use (`model` field)
- **Auto-approval rules** — which tool calls to allow automatically (`autoApproval`)
- **Sandbox** — isolated execution environment (`sandbox`) → delegate to the `sandbox-configurator` agent
- **MCP servers** — external tool integrations (`mcpServers`)
- **Claude Code plugins** — reuse Claude Code plugin prompts/agents (`claudeCodePlugins`)
- **Voice input** — voice transcription settings (`voiceInput`)
- **Notifications** — custom notify command (`notifyCmd`)

If the request is vague, ask a focused clarifying question before proceeding.

## Step 4: Apply Changes

Update `.plain-agent/config.json`. Rules:

- Merge carefully — preserve all existing keys.
- Only write to `.plain-agent/config.json`. Never access files outside the project directory.
- For credential-requiring fields, use a placeholder like `"<YOUR_API_KEY>"` and instruct the user to add the real value to `.plain-agent/config.local.json` themselves.

## Step 5: Summarize

1. Show a diff or summary of what changed.
2. If any credentials were skipped, show the snippet the user needs to add to `config.local.json`.
3. Tell the user to restart `plain` for changes to take effect.
