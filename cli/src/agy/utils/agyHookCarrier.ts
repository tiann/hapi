import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/ui/logger';

export type AgyHookCarrier = {
    carrierDir: string;
};

export type AgyMcpServerEntry = {
    command: string;
    args?: string[];
    env?: Record<string, string>;
};

/**
 * Create an extra AGY workspace containing HAPI's session-local hook and MCP plugin.
 * The user's HOME, global hooks, and target project remain untouched.
 */
export function prepareAgyHookCarrier(
    hooksJsonContent: string,
    mcpServer?: AgyMcpServerEntry
): AgyHookCarrier | undefined {
    let carrierDir: string | undefined;
    try {
        carrierDir = mkdtempSync(join(tmpdir(), 'hapi-agy-carrier-'));
        const agentsDir = join(carrierDir, '.agents');
        mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(agentsDir, 'hooks.json'), hooksJsonContent, { mode: 0o600 });
        if (mcpServer) {
            const pluginDir = join(agentsDir, 'plugins', 'hapi');
            mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
            writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'hapi' }), { mode: 0o600 });
            writeFileSync(
                join(pluginDir, 'mcp_config.json'),
                JSON.stringify({ mcpServers: { hapi: mcpServer } }),
                { mode: 0o600 }
            );
        }
        logger.debug(`[agyHookCarrier] prepared at ${carrierDir}`);
        return { carrierDir };
    } catch (error) {
        if (carrierDir) {
            try { rmSync(carrierDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
        logger.debug('[agyHookCarrier] preparation failed', error);
        return undefined;
    }
}

export function cleanupAgyHookCarrier(carrierDir: string | undefined): void {
    if (!carrierDir) return;
    try {
        rmSync(carrierDir, { recursive: true, force: true });
        logger.debug(`[agyHookCarrier] cleaned up ${carrierDir}`);
    } catch (error) {
        logger.debug(`[agyHookCarrier] cleanup failed for ${carrierDir}`, error);
    }
}
