import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';

export interface SlashCommand {
    name: string;
    description?: string;
    source: 'builtin' | 'user';
    content?: string;  // Expanded content for Codex user prompts
}

export interface ListSlashCommandsRequest {
    agent: string;
}

export interface ListSlashCommandsResponse {
    success: boolean;
    commands?: SlashCommand[];
    error?: string;
}

/**
 * Built-in slash commands for each agent type.
 */
const BUILTIN_COMMANDS: Record<string, SlashCommand[]> = {
    claude: [
        { name: 'clear', description: 'Clear conversation history', source: 'builtin' },
        { name: 'compact', description: 'Compact conversation context', source: 'builtin' },
        { name: 'context', description: 'Show context information', source: 'builtin' },
        { name: 'cost', description: 'Show session cost', source: 'builtin' },
        { name: 'plan', description: 'Toggle plan mode', source: 'builtin' },
    ],
    codex: [
        { name: 'review', description: 'Review code', source: 'builtin' },
        { name: 'new', description: 'Start new conversation', source: 'builtin' },
        { name: 'compat', description: 'Check compatibility', source: 'builtin' },
        { name: 'undo', description: 'Undo last action', source: 'builtin' },
    ],
    gemini: [
        { name: 'about', description: 'About Gemini', source: 'builtin' },
        { name: 'clear', description: 'Clear conversation', source: 'builtin' },
        { name: 'compress', description: 'Compress context', source: 'builtin' },
    ],
};

/**
 * Parse frontmatter from a markdown file content.
 * Returns the description (from frontmatter) and the body content.
 */
function parseFrontmatter(fileContent: string): { description?: string; content: string } {
    // Match frontmatter: starts with ---, ends with ---
    const match = fileContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (match) {
        const yamlContent = match[1];
        const body = match[2].trim();
        try {
            const parsed = parseYaml(yamlContent) as Record<string, unknown> | null;
            const description = typeof parsed?.description === 'string' ? parsed.description : undefined;
            return { description, content: body };
        } catch {
            // Invalid YAML - the --- block is not valid frontmatter, return entire file
            return { content: fileContent.trim() };
        }
    }
    // No frontmatter, entire file is content
    return { content: fileContent.trim() };
}

/**
 * Get the user commands directory for an agent type.
 * Returns null if the agent doesn't support user commands.
 */
function getUserCommandsDir(agent: string): string | null {
    switch (agent) {
        case 'claude': {
            const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
            return join(configDir, 'commands');
        }
        case 'codex': {
            const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
            return join(codexHome, 'prompts');
        }
        default:
            // Gemini and other agents don't have user commands
            return null;
    }
}

/**
 * Scan a directory for user-defined commands (*.md files).
 * For Codex, reads file content and parses frontmatter.
 * Returns the command names (filename without extension).
 */
async function scanUserCommands(agent: string): Promise<SlashCommand[]> {
    const dir = getUserCommandsDir(agent);
    if (!dir) {
        return [];
    }

    const shouldReadContent = agent === 'codex';

    try {
        const entries = await readdir(dir, { withFileTypes: true });
        const mdFiles = entries.filter(e => e.isFile() && e.name.endsWith('.md'));

        // Read all files in parallel
        const commands = await Promise.all(
            mdFiles.map(async (entry): Promise<SlashCommand | null> => {
                const name = entry.name.slice(0, -3);
                if (!name) return null;

                const command: SlashCommand = {
                    name,
                    description: 'Custom command',
                    source: 'user',
                };

                if (shouldReadContent) {
                    try {
                        const filePath = join(dir, entry.name);
                        const fileContent = await readFile(filePath, 'utf-8');
                        const parsed = parseFrontmatter(fileContent);
                        if (parsed.description) {
                            command.description = parsed.description;
                        }
                        command.content = parsed.content;
                    } catch {
                        // Failed to read file, keep default description
                    }
                }

                return command;
            })
        );

        // Filter nulls and sort alphabetically
        return commands
            .filter((cmd): cmd is SlashCommand => cmd !== null)
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
        // Directory doesn't exist or not accessible - return empty array
        return [];
    }
}

/**
 * List all available slash commands for an agent type.
 * Returns built-in commands plus user-defined commands.
 */
export async function listSlashCommands(agent: string): Promise<SlashCommand[]> {
    const builtin = BUILTIN_COMMANDS[agent] ?? [];
    const user = await scanUserCommands(agent);

    // Combine: built-in first, then user commands
    return [...builtin, ...user];
}
