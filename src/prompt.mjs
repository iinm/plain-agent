import { toOneLine } from "./utils/toOneLine.mjs";

/**
 * @typedef {object} PromptConfig
 * @property {string} username
 * @property {string} modelName
 * @property {string} workingDir - The current working directory.
 * @property {string} today - Today's date in YYYY-MM-DD format.
 * @property {string} sessionId
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

Memory files preserve state to resume work after context resets.

- Create/Update memory files when creating/updating a plan, completing milestones, encountering issues, or making decisions.
- Skip memory files for tasks that can be completed in a few steps.
- Write the memory content in the user's language.

Memory files should include:
- Task overview: What the task is, why it's being done, requirements and constraints
- References: AGENTS.md, documentation, source files, commands
- Progress tracking: Completed milestones with results, current status, and next steps
- Decision records: Key decisions, alternatives considered, and reason

# Tools

- Run independent tools in parallel.
- Verify line numbers and hashes with read_file before calling patch_file.
- Use relative paths for files inside the working directory, absolute paths for files outside.
- Use ${projectMetadataDir}/tmp/ for temporary files.

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

- Session id: ${sessionId}
- Memory file path: ${projectMetadataDir}/memory/${sessionId}--<kebab-case-title>.md
- User name: ${username}
- Your model name: ${modelName}
- Current working directory: ${workingDir}
- Today's date: ${today}

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
