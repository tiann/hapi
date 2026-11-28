/**
 * OpenCode configuration file generator.
 *
 * Generates opencode.json with MCP server configuration and instructions
 * for the hapi change_title tool.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_FILENAME = 'opencode.json';
const INSTRUCTIONS_FILENAME = 'hapi-instructions.md';

interface McpServerEntry {
    command: string;
    args: string[];
}

/** Cover auth + lookup + hub archive Runner cleanup (90s) plus bridge overhead.
 *  OpenCode v1 defaults MCP tool calls to the SDK's 60s deadline when this is
 *  omitted; progress heartbeats alone are not enough if the client never
 *  sends a progressToken. */
const HAPI_MCP_REQUEST_TIMEOUT_MS = 140_000;

interface OpencodeConfig {
    $schema: string;
    mcp: Record<string, {
        type: string;
        command: string[];
        enabled: boolean;
        timeout?: number;
    }>;
    instructions: string[];
}

/**
 * Ensures the opencode.json config file exists with MCP server and instructions.
 *
 * @param rootPath - The OPENCODE_CONFIG_DIR path
 * @param mcpServer - The hapi MCP server command configuration
 * @param instructions - The instruction text to write to the instructions file
 */
export function ensureOpencodeConfig(
    rootPath: string,
    mcpServer: McpServerEntry,
    instructions: string
): { configPath: string; instructionsPath: string } {
    mkdirSync(rootPath, { recursive: true });

    // Write instructions file
    const instructionsPath = join(rootPath, INSTRUCTIONS_FILENAME);
    writeFileSafe(instructionsPath, instructions);

    // Build opencode.json config
    // Use absolute path for instructions since OpenCode resolves paths relative to project root
    const config: OpencodeConfig = {
        $schema: 'https://opencode.ai/config.json',
        mcp: {
            hapi: {
                type: 'local',
                command: [mcpServer.command, ...mcpServer.args],
                enabled: true,
                timeout: HAPI_MCP_REQUEST_TIMEOUT_MS,
            }
        },
        instructions: [instructionsPath]
    };

    const configPath = join(rootPath, CONFIG_FILENAME);
    const configJson = JSON.stringify(config, null, 2);
    writeFileSafe(configPath, configJson);

    return { configPath, instructionsPath };
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
