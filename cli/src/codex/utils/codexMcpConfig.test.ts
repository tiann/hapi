import { describe, it, expect } from 'vitest';
import {
    buildMcpServerConfigArgs,
    buildDeveloperInstructionsArg,
    buildSessionStartHookConfigArgs
} from './codexMcpConfig';

describe('codexMcpConfig', () => {
    describe('buildMcpServerConfigArgs', () => {
        it('builds config args for a single MCP server', () => {
            const mcpServers = {
                hapi: {
                    command: 'hapi',
                    args: ['mcp', '--url', 'http://localhost:3000']
                }
            };

            const args = buildMcpServerConfigArgs(mcpServers);

            expect(args).toEqual([
                '-c', 'mcp_servers.hapi.command="hapi"',
                '-c', "mcp_servers.hapi.args=['mcp','--url','http://localhost:3000']"
            ]);
        });

        it('builds config args for multiple MCP servers', () => {
            const mcpServers = {
                hapi: { command: 'hapi', args: ['mcp'] },
                other: { command: 'node', args: ['server.js'] }
            };

            const args = buildMcpServerConfigArgs(mcpServers);

            expect(args).toContain('-c');
            expect(args).toContain('mcp_servers.hapi.command="hapi"');
            expect(args).toContain('mcp_servers.other.command="node"');
        });

        it('handles empty args array', () => {
            const mcpServers = {
                simple: { command: 'simple-server', args: [] }
            };

            const args = buildMcpServerConfigArgs(mcpServers);

            expect(args).toContain('mcp_servers.simple.args=[]');
        });

        it('escapes special characters in command', () => {
            const mcpServers = {
                test: { command: 'path/to/server', args: [] }
            };

            const args = buildMcpServerConfigArgs(mcpServers);

            expect(args).toContain('mcp_servers.test.command="path/to/server"');
        });
    });

    describe('buildDeveloperInstructionsArg', () => {
        it('builds developer instructions arg', () => {
            const instructions = 'Call functions.hapi__change_title to set title.';

            const args = buildDeveloperInstructionsArg(instructions);

            expect(args).toEqual([
                '-c',
                'developer_instructions="Call functions.hapi__change_title to set title."'
            ]);
        });

        it('escapes double quotes', () => {
            const instructions = 'Use "quotes" in text.';

            const args = buildDeveloperInstructionsArg(instructions);

            expect(args[1]).toContain('\\"quotes\\"');
        });

        it('escapes newlines', () => {
            const instructions = 'Line 1\nLine 2';

            const args = buildDeveloperInstructionsArg(instructions);

            expect(args[1]).toContain('\\n');
            expect(args[1]).not.toContain('\n');
        });

        it('escapes backslashes', () => {
            const instructions = 'Path: C:\\Users\\test';

            const args = buildDeveloperInstructionsArg(instructions);

            expect(args[1]).toContain('\\\\');
        });
    });

    describe('buildSessionStartHookConfigArgs', () => {
        it('builds a SessionStart hook config override', () => {
            const args = buildSessionStartHookConfigArgs(4312, 'secret-token');

            expect(args[0]).toBe('-c');
            expect(args[1]).toContain('hooks.SessionStart=[');
            expect(args[1]).toContain('type = "command"');
            expect(args[1]).toContain('hook-forwarder --port 4312 --token secret-token');
            expect(args[2]).toBe('-c');
            expect(args[3]).toContain('hooks.state={');
            expect(args[3]).toContain(':session_start:0:0');
            expect(args[3]).toContain('trusted_hash="sha256:');
        });
    });
});
