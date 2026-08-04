import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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

/**
 * True if the carrier's hooks.json is present and therefore safe to
 * overwrite in place. False covers both "the whole carrier directory is
 * gone" (e.g. /tmp's 30-day tmpfiles.d sweep on a long-lived session, see
 * the agy-preinvocation-discovery plan §9) and "hooks.json specifically was
 * removed" — either way, the caller must rebuild the carrier from scratch
 * (prepareAgyHookCarrier) rather than attempt an atomic overwrite, since
 * writeAgyHooksJsonAtomic requires the .agents directory to already exist.
 */
export function agyHookCarrierIsIntact(carrierDir: string): boolean {
    return existsSync(join(carrierDir, '.agents', 'hooks.json'));
}

/**
 * Overwrite an existing carrier's hooks.json in place, atomically.
 *
 * agy re-reads hooks.json before every single model call (confirmed live —
 * see the agy-preinvocation-discovery plan §6.6), not just once at spawn
 * time. That means a plain writeFileSync has a real window where agy can
 * observe a partially-written file: JSON.parse throws, agy drops every hook
 * registered under this carrier for that read (including the PreToolUse
 * permission bridge, not just the PreInvocation discovery hook this function
 * is used to add/remove). Writing to a sibling temp file in the same
 * directory and renaming over the target avoids that window — rename() is
 * atomic on the same filesystem, so agy only ever observes the old complete
 * file or the new complete file, never a partial one.
 *
 * Throws if the carrier's .agents directory does not exist; callers must
 * check agyHookCarrierIsIntact() first and fall back to
 * prepareAgyHookCarrier() (a fresh carrier) if it does not.
 */
export function writeAgyHooksJsonAtomic(carrierDir: string, hooksJsonContent: string): void {
    const agentsDir = join(carrierDir, '.agents');
    const target = join(agentsDir, 'hooks.json');
    const tmpPath = join(agentsDir, `.hooks.json.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tmpPath, hooksJsonContent, { mode: 0o600 });
    renameSync(tmpPath, target);
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
