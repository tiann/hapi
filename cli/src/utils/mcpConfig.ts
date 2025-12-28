/**
 * MCP configuration file utilities
 *
 * Claude CLI's --mcp-config expects a file path, not inline JSON.
 * This module writes MCP config to a temp file and returns the path.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuration } from '@/configuration';

const RUNTIME_DIR = join(configuration.happyHomeDir, 'runtime');
const MCP_CONFIG_FILE = join(RUNTIME_DIR, 'mcp-config.json');

/**
 * Write MCP servers config to a file and return the file path.
 * Claude CLI's --mcp-config flag requires a file path, not inline JSON.
 */
export function writeMcpConfigFile(mcpServers: Record<string, unknown>): string {
    if (!existsSync(RUNTIME_DIR)) {
        mkdirSync(RUNTIME_DIR, { recursive: true });
    }

    const config = { mcpServers };
    writeFileSync(MCP_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');

    return MCP_CONFIG_FILE;
}
