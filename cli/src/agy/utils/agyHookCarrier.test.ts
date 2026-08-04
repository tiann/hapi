import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
    agyHookCarrierIsIntact,
    cleanupAgyHookCarrier,
    prepareAgyHookCarrier,
    writeAgyHooksJsonAtomic
} from './agyHookCarrier';

describe('agy hook carrier', () => {
    it('creates workspace-local hooks and a session-scoped HAPI MCP plugin', () => {
        const hooks = '{"hapi-bridge":{}}';
        const mcpServer = { command: '/opt/hapi', args: ['mcp', '--url', 'http://127.0.0.1:4312'] };
        const result = prepareAgyHookCarrier(hooks, mcpServer);
        expect(result).toBeDefined();
        if (!result) return;

        try {
            expect(readFileSync(join(result.carrierDir, '.agents', 'hooks.json'), 'utf8')).toBe(hooks);
            const pluginDir = join(result.carrierDir, '.agents', 'plugins', 'hapi');
            expect(JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8'))).toEqual({ name: 'hapi' });
            expect(JSON.parse(readFileSync(join(pluginDir, 'mcp_config.json'), 'utf8'))).toEqual({
                mcpServers: { hapi: mcpServer }
            });
            expect(statSync(join(pluginDir, 'mcp_config.json')).mode & 0o777).toBe(0o600);
        } finally {
            cleanupAgyHookCarrier(result.carrierDir);
        }
    });

    it('removes the carrier after the session exits', () => {
        const result = prepareAgyHookCarrier('{}');
        expect(result).toBeDefined();
        if (!result) return;

        cleanupAgyHookCarrier(result.carrierDir);
        expect(existsSync(result.carrierDir)).toBe(false);
    });
});

describe('writeAgyHooksJsonAtomic', () => {
    it('overwrites an existing carrier\'s hooks.json in place, leaving no stray temp file behind', () => {
        const result = prepareAgyHookCarrier('{"hapi-bridge":{"PreToolUse":[]}}');
        expect(result).toBeDefined();
        if (!result) return;

        try {
            const replacement = '{"hapi-bridge":{"PreToolUse":[],"PreInvocation":[]}}';
            writeAgyHooksJsonAtomic(result.carrierDir, replacement);

            const agentsDir = join(result.carrierDir, '.agents');
            expect(readFileSync(join(agentsDir, 'hooks.json'), 'utf8')).toBe(replacement);
            // The atomic-write temp file must be renamed away, not merely
            // written alongside the target — a leftover .tmp file would mean
            // the rename step silently failed or was skipped.
            expect(readdirSync(agentsDir).sort()).toEqual(['hooks.json']);
        } finally {
            cleanupAgyHookCarrier(result.carrierDir);
        }
    });

    it('throws when the carrier does not exist — callers must check agyHookCarrierIsIntact() first', () => {
        expect(() => writeAgyHooksJsonAtomic('/tmp/hapi-agy-carrier-does-not-exist', '{}')).toThrow();
    });
});

describe('agyHookCarrierIsIntact', () => {
    it('is true when hooks.json is present', () => {
        const result = prepareAgyHookCarrier('{}');
        expect(result).toBeDefined();
        if (!result) return;

        try {
            expect(agyHookCarrierIsIntact(result.carrierDir)).toBe(true);
        } finally {
            cleanupAgyHookCarrier(result.carrierDir);
        }
    });

    it('is false once the carrier has been cleaned up (directory gone entirely)', () => {
        const result = prepareAgyHookCarrier('{}');
        expect(result).toBeDefined();
        if (!result) return;

        cleanupAgyHookCarrier(result.carrierDir);
        expect(agyHookCarrierIsIntact(result.carrierDir)).toBe(false);
    });
});
