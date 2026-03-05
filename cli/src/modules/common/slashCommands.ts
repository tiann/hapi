import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';

export interface SlashCommand {
    name: string;
    description?: string;
    source: 'builtin' | 'user' | 'plugin' | 'project';
    content?: string;  // Expanded content for Codex user prompts
    pluginName?: string;  // Name of the plugin that provides this command
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
    codex: [],
    gemini: [
        { name: 'about', description: 'About Gemini', source: 'builtin' },
        { name: 'clear', description: 'Clear conversation', source: 'builtin' },
        { name: 'compress', description: 'Compress context', source: 'builtin' },
    ],
    opencode: [],
};

/**
 * Interface for installed_plugins.json structure
 */
interface InstalledPluginsFile {
    version: number;
    plugins: Record<string, Array<{
        scope: string;
        installPath: string;
        version: string;
        installedAt: string;
        lastUpdated: string;
        gitCommitSha?: string;
    }>>;
}

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
 * Get the project commands directory for an agent type.
 * Returns null if the agent doesn't support project commands.
 */
function getProjectCommandsDir(agent: string, projectDir: string): string | null {
    switch (agent) {
        case 'claude':
            return join(projectDir, '.claude', 'commands');
        case 'codex':
            return join(projectDir, '.codex', 'prompts');
        default:
            // Gemini and other agents don't have project commands
            return null;
    }
}

/**
 * Scan a directory for commands (*.md files).
 * Returns commands with parsed frontmatter.
 */
async function scanCommandsDir(
    dir: string,
    source: 'user' | 'plugin' | 'project',
    pluginName?: string
): Promise<SlashCommand[]> {
    async function scanRecursive(currentDir: string, segments: string[]): Promise<SlashCommand[]> {
        const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => null);
        if (!entries) {
            return [];
        }

        const commandsByEntry = await Promise.all(
            entries.map(async (entry): Promise<SlashCommand[]> => {
                if (entry.name.startsWith('.') || entry.isSymbolicLink()) {
                    return [];
                }

                if (entry.isDirectory()) {
                    if (entry.name.includes(':')) return [];
                    return scanRecursive(join(currentDir, entry.name), [...segments, entry.name]);
                }

                if (!entry.isFile() || !entry.name.endsWith('.md')) {
                    return [];
                }

                const baseName = entry.name.slice(0, -3);
                if (!baseName || baseName.includes(':')) {
                    return [];
                }

                const localName = [...segments, baseName].join(':');
                const name = pluginName ? `${pluginName}:${localName}` : localName;
                const fallbackDescription = source === 'plugin' ? `${pluginName ?? 'plugin'} command` : 'Custom command';

                try {
                    const filePath = join(currentDir, entry.name);
                    const fileContent = await readFile(filePath, 'utf-8');
                    const parsed = parseFrontmatter(fileContent);

                    return [{
                        name,
                        description: parsed.description ?? fallbackDescription,
                        source,
                        content: parsed.content,
                        pluginName,
                    }];
                } catch {
                    return [{
                        name,
                        description: fallbackDescription,
                        source,
                        pluginName,
                    }];
                }
            })
        );

        return commandsByEntry.flat();
    }

    const commands = await scanRecursive(dir, []);
    return commands.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Scan user-defined commands from ~/.claude/commands/ or equivalent
 */
async function scanUserCommands(agent: string): Promise<SlashCommand[]> {
    const dir = getUserCommandsDir(agent);
    if (!dir) {
        return [];
    }
    return scanCommandsDir(dir, 'user');
}

/**
 * Scan project-defined commands from <projectDir>/.claude/commands/ or equivalent.
 */
async function scanProjectCommands(agent: string, projectDir?: string): Promise<SlashCommand[]> {
    if (!projectDir) {
        return [];
    }

    const dir = getProjectCommandsDir(agent, projectDir);
    if (!dir) {
        return [];
    }

    return scanCommandsDir(dir, 'project');
}

/**
 * Scan plugin commands from installed Claude plugins.
 * Reads ~/.claude/plugins/installed_plugins.json to find installed plugins,
 * then scans each plugin's commands directory.
 */
async function scanPluginCommands(agent: string): Promise<SlashCommand[]> {
    // Only Claude supports plugins for now
    if (agent !== 'claude') {
        return [];
    }

    const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    const installedPluginsPath = join(configDir, 'plugins', 'installed_plugins.json');

    try {
        const content = await readFile(installedPluginsPath, 'utf-8');
        const installedPlugins = JSON.parse(content) as InstalledPluginsFile;

        if (!installedPlugins.plugins) {
            return [];
        }

        const allCommands: SlashCommand[] = [];

        // Process each installed plugin
        for (const [pluginKey, installations] of Object.entries(installedPlugins.plugins)) {
            // Plugin key format: "pluginName@marketplace" or "@scope/pluginName@marketplace"
            // Use the last '@' as the separator between plugin name and marketplace
            const lastAtIndex = pluginKey.lastIndexOf('@');
            const pluginName = lastAtIndex > 0 ? pluginKey.substring(0, lastAtIndex) : pluginKey;

            if (installations.length === 0) continue;

            // Sort installations by lastUpdated descending to get the newest one
            const sortedInstallations = [...installations].sort((a, b) => {
                return new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime();
            });

            const installation = sortedInstallations[0];
            if (!installation?.installPath) continue;

            const commandsDir = join(installation.installPath, 'commands');
            const commands = await scanCommandsDir(commandsDir, 'plugin', pluginName);
            allCommands.push(...commands);
        }

        return allCommands.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
        // installed_plugins.json doesn't exist or is invalid
        return [];
    }
}

/**
 * List all available slash commands for an agent type.
 * Returns built-in commands, user-defined commands, plugin commands, and project commands.
 *
 * Merge order follows locality precedence for custom commands:
 * built-in -> global user -> plugin -> project (project overrides same-name globals).
 */
export async function listSlashCommands(agent: string, projectDir?: string): Promise<SlashCommand[]> {
    const builtin = BUILTIN_COMMANDS[agent] ?? [];

    // Scan all command sources in parallel
    const [user, plugin, project] = await Promise.all([
        scanUserCommands(agent),
        scanPluginCommands(agent),
        scanProjectCommands(agent, projectDir),
    ]);

    const allCommands = [...builtin, ...user, ...plugin, ...project];

    // Keep insertion order while allowing latter commands to override prior ones.
    const commandMap = new Map<string, SlashCommand>();
    for (const command of allCommands) {
        if (commandMap.has(command.name)) {
            commandMap.delete(command.name);
        }
        commandMap.set(command.name, command);
    }

    return Array.from(commandMap.values());
}
