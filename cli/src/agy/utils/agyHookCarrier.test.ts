import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupAgyHookCarrier, prepareAgyHookCarrier } from './agyHookCarrier';

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
