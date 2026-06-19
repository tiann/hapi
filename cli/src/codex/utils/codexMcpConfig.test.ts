import { describe, it, expect } from 'vitest';
import {
    buildMcpServerConfigArgs,
    buildDeveloperInstructionsArg,
    buildCodexHookConfigArgs
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

        it('builds per-tool approval mode config', () => {
            const mcpServers = {
                hapi: {
                    command: 'hapi',
                    args: ['mcp'],
                    tools: {
                        change_title: {
                            approval_mode: 'approve' as const
                        },
                        display_image: {
                            approval_mode: 'approve' as const
                        }
                    }
                }
            };

            const args = buildMcpServerConfigArgs(mcpServers);

            expect(args).toContain('mcp_servers.hapi.tools.change_title.approval_mode="approve"');
            expect(args).toContain('mcp_servers.hapi.tools.display_image.approval_mode="approve"');
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

    describe('buildCodexHookConfigArgs', () => {
        it('builds trusted SessionStart and tool lifecycle hook overrides', () => {
            const args = buildCodexHookConfigArgs(4312, 'secret-token');

            expect(args[0]).toBe('-c');
            expect(args[1]).toContain('hooks.SessionStart=[');
            expect(args[1]).toContain('type = "command"');
            expect(args[1]).toContain('hook-forwarder --port 4312 --token secret-token');
            expect(args[2]).toBe('-c');
            expect(args[3]).toContain('hooks.PreToolUse=[');
            expect(args[3]).toContain('matcher = "*"');
            expect(args[5]).toContain('hooks.PostToolUse=[');
            expect(args[5]).toContain('matcher = "*"');
            expect(args[7]).toContain('hooks.state={');
            expect(args[7]).toContain(':session_start:0:0');
            expect(args[7]).toContain(':pre_tool_use:0:0');
            expect(args[7]).toContain(':post_tool_use:0:0');
            expect(args[7].match(/trusted_hash="sha256:/g)).toHaveLength(3);
        });
    });
});
