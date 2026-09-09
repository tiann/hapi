/**
 * OpenCode configuration file generator.
 *
 * Generates opencode.json with the HAPI MCP server configuration.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_FILENAME = 'opencode.json';

interface McpServerEntry {
    command: string;
    args: string[];
}

interface OpencodeConfig {
    $schema: string;
    mcp: Record<string, {
        type: string;
        command: string[];
        enabled: boolean;
    }>;
}

/**
 * Ensures the opencode.json config file exists with the MCP server.
 *
 * @param rootPath - The OPENCODE_CONFIG_DIR path
 * @param mcpServer - The hapi MCP server command configuration
 */
export function ensureOpencodeConfig(
    rootPath: string,
    mcpServer: McpServerEntry
): { configPath: string } {
    mkdirSync(rootPath, { recursive: true });

    // Build opencode.json config
    const config: OpencodeConfig = {
        $schema: 'https://opencode.ai/config.json',
        mcp: {
            hapi: {
                type: 'local',
                command: [mcpServer.command, ...mcpServer.args],
                enabled: true
            }
        }
    };

    const configPath = join(rootPath, CONFIG_FILENAME);
    const configJson = JSON.stringify(config, null, 2);
    writeFileSafe(configPath, configJson);

    return { configPath };
}

/**
 * Write file only if content has changed.
 */
function writeFileSafe(filePath: string, content: string): void {
    try {
        const current = readFileSync(filePath, 'utf-8');
        if (current === content) {
            return;
        }
    } catch {
        // Ignore missing or unreadable file
    }
    writeFileSync(filePath, content, 'utf-8');
}
