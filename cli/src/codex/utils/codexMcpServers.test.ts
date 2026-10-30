import { describe, expect, it } from 'vitest';
import {
    extractCodexMcpServers,
    HAPI_MCP_SERVER_NAME,
    mergeCodexMcpServers
} from './codexMcpServers';

describe('codexMcpServers', () => {
    it('extracts stdio and HTTP servers while preserving transport-specific fields', () => {
        const result = extractCodexMcpServers({
            mcp_servers: {
                'package-manager': {
                    command: 'uvx',
                    args: ['example-mcp', 'serve'],
                    env: { EXAMPLE_TOKEN: 'from-process-environment' },
                    environment_id: 'local',
                    enabled: true,
                    tool_timeout_sec: 60
                },
                remote: {
                    url: 'https://example.test/mcp',
                    bearer_token_env_var: 'REMOTE_MCP_TOKEN'
                }
            }
        });

        expect(result).toEqual({
            'package-manager': {
                command: 'uvx',
                args: ['example-mcp', 'serve'],
                env: { EXAMPLE_TOKEN: 'from-process-environment' },
                environment_id: 'local',
                enabled: true,
                tool_timeout_sec: 60
            },
            remote: {
                url: 'https://example.test/mcp',
                bearer_token_env_var: 'REMOTE_MCP_TOKEN'
            }
        });
    });

    it('returns no servers when the effective config has no MCP table', () => {
        expect(extractCodexMcpServers({ model: 'gpt-5' })).toEqual({});
        expect(extractCodexMcpServers(null)).toEqual({});
    });

    it('rejects malformed MCP entries before they reach app-server', () => {
        expect(() => extractCodexMcpServers({
            mcp_servers: {
                broken: {
                    command: ['not', 'a', 'command']
                }
            }
        })).toThrow('Invalid Codex MCP server configuration for "broken"');
    });

    it('omits null defaults returned by config/read', () => {
        expect(extractCodexMcpServers({
            mcp_servers: {
                external: {
                    command: 'server',
                    args: [],
                    environment_id: 'local',
                    enabled: true,
                    tool_timeout_sec: null,
                    startup_timeout_sec: undefined
                }
            }
        })).toEqual({
            external: {
                command: 'server',
                args: [],
                environment_id: 'local',
                enabled: true
            }
        });
    });

    it('reserves the HAPI server name and keeps the HAPI bridge on merge', () => {
        const merged = mergeCodexMcpServers(
            {
                [HAPI_MCP_SERVER_NAME]: { command: 'user-hapi', args: [] },
                external: { command: 'external', args: [] }
            },
            {
                [HAPI_MCP_SERVER_NAME]: { command: 'hapi', args: ['mcp'] }
            }
        );

        expect(merged).toEqual({
            external: { command: 'external', args: [] },
            [HAPI_MCP_SERVER_NAME]: { command: 'hapi', args: ['mcp'] }
        });
    });
});
