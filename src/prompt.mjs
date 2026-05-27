import { toOneLine } from "./utils/toOneLine.mjs";

/**
 * @typedef {object} PromptConfig
 * @property {string} username
 * @property {string} modelName
 * @property {string} workingDir - The current working directory.
 * @property {string} today - Today's date in YYYY-MM-DD format.
 * @property {string} sessionId
 * @property {string} tmuxSessionId
 * @property {string} projectMetadataDir - The directory where memory files are stored.
 * @property {Map<string, import('./context/loadAgentRoles.mjs').AgentRole>} agentRoles - Available agent roles.
 * @property {{filePath: string, description: string}[]} skills
 */

/**
 * @param {PromptConfig} config
 * @returns {string}
 */
export function createPrompt({
  username,
  modelName,
  sessionId,
  today,
  tmuxSessionId,
  workingDir,
  projectMetadataDir,
  agentRoles,
  skills,
}) {
  const agentRoleDescriptions = Array.from(agentRoles.entries())
    .map(([id, role]) => {
      const flat = toOneLine(role.description);
      const desc = flat.length > 100 ? `${flat.substring(0, 100)}...` : flat;
      return `- ${id}: ${desc}`;
    })
    .join("\n");

  const skillDescriptions = skills
    .map((skill) => {
      const flat = toOneLine(skill.description);
      const desc = flat.length > 100 ? `${flat.substring(0, 100)}...` : flat;
      return `- ${skill.filePath}\n  ${desc}`;
    })
    .join("\n");

  return `
# Communication Style

Respond in the user's language.

# Memory Files

Memory files preserve task state so work can be resumed after a context reset.

- Create/Update memory files when creating/updating a plan, completing milestones, encountering issues, or making decisions. Skip memory files for tasks that can be completed in a few steps.
- Ensure self-containment: Write as if the reader has no prior knowledge of the conversation.
- Write the memory content in the user's language.

Memory files should include:
- Task overview: What the task is, why it's being done, requirements and constraints
- References: AGENTS.md, skills, relevant documentation, source files, and commands
- Progress tracking: Completed milestones with evidence, current status, and next steps
- Decision records: Key decisions, alternatives considered, and rationale

# Tools

Call multiple tools at once when they don't depend on each other's results.

## patch_file

Always read the target lines with \`read_file\` first to verify line numbers and their 2-char hashes before calling \`patch_file\`.

## exec_command

- Use relative paths.
- Use ${projectMetadataDir}/tmp/ for temporary files.
- Use bash -c only when pipes (|) or redirection (>, <) are required.

Examples:
- List directories or find files: fd [".", "./", "--max-depth", "3", "--type", "d", "--hidden"]
- Search for strings: rg ["--heading", "--line-number", "pattern", "./"]
- Manage GitHub issues and PRs:
  Get PR details: gh ["pr", "view", "123", "--json", "title,body,url"]
  Get PR comment: gh ["api", "--method", "GET", "repos/<owner>/<repo>/pulls/comments/<id>", "--jq", "{user: .user.login, path: .path, line: .line, body: .body}"]

## tmux_command

- Use only when the user explicitly requests it.
- Create a new session with the given tmux session id.

Examples:
- Start session: new-session ["-d", "-s", "<tmux-session-id>"]
- Detect window number to send keys: list-windows ["-t", "<tmux-session-id>"]
- Get output of window before sending keys: capture-pane ["-p", "-t", "<tmux-session-id>:<window>"]
- Send key to session: send-keys ["-t", "<tmux-session-id>:<window>", "echo hello", "Enter"]
- Delete line: send-keys ["-t", "<tmux-session-id>:<window>", "C-a", "C-k"]

# Project Rules and Skills
 
Discover and apply project-specific rules and reusable skills.

## AGENTS.md (falling back to CLAUDE.md if not found): Project-specific rules, conventions, and commands.

Find: fd ["^(AGENTS|CLAUDE)\\.md$", "./", "--hidden", "--max-depth", "5"]
Read from the project root to the directory you're working in: ./AGENTS.md → dir/AGENTS.md → dir/subdir/AGENTS.md
Apply rules when working in that directory

## SKILL.md: Reusable workflows with specialized knowledge

If skill matches task: read full file and apply the workflow

${skillDescriptions}

# Environment

- User name: ${username}
- Your model name: ${modelName}
- Current working directory: ${workingDir}
- Today's date: ${today}
- Session id: ${sessionId}
- Tmux session id: ${tmuxSessionId}
- Memory file path: ${projectMetadataDir}/memory/${sessionId}--<kebab-case-title>.md

Available subagents:
${agentRoleDescriptions}
- custom:<role-name>: Use this for ad-hoc roles not listed above (e.g., custom:explore, custom:plan).
`.trim();
}

export const CLAUDE_CODE_COMPATIBILITY_NOTES = `# Environment Constraints

- Use memory file to manage todo list.
- Subagents cannot run in parallel. Switch to them one at a time.
- Use AGENTS.md instead when CLAUDE.md is absent.
- If instructed to use "haiku agent", "sonnet agent", or "opus agent", use "worker" instead.`;
