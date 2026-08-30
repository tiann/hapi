import { describe, expect, it } from 'vitest'
import type { ContextDetails, Metadata } from '@hapi/protocol'
import {
    buildClaudeContextDetails,
    buildCodexContextDetails,
    mergeContextDetails,
    publishContextDetails
} from './contextDetails'

describe('Claude context details', () => {
    it('keeps detailed SDK init lists when no /context payload is available', () => {
        const details = buildClaudeContextDetails({
            updatedAt: 100,
            system: {
                model: 'claude-sonnet',
                tools: ['Read', 'Bash'],
                skills: ['find-docs', 'web-search'],
                slash_commands: ['/context', '/compact']
            }
        })

        expect(details).toMatchObject({
            claude: {
                systemTools: ['Read', 'Bash'],
                skills: [{ name: 'find-docs' }, { name: 'web-search' }],
                slashCommands: ['/context', '/compact']
            }
        })
    })

    it('keeps only displayed inventories without prompt or resource content', () => {
        const details = buildClaudeContextDetails({
            updatedAt: 100,
            system: {
                model: 'claude-sonnet',
                tools: ['Read', 'Bash'],
                slash_commands: ['/context', '/compact']
            },
            contextUsage: {
                model: 'claude-sonnet',
                total_tokens: 26_697,
                raw_max_tokens: 262_144,
                categories: [{ name: 'System tools', tokens: 19_740, kind: 'used' }],
                memory_files: [{ path: '/workspace/AGENTS.md', type: 'Project', tokens: 2_998 }],
                skills: [{ name: 'find-docs', source: 'user', tokens: 2_604 }],
                agents: [{ agent_type: 'probe', source: 'flagSettings', tokens: 13 }],
                mcp_tools: [{ name: 'mcp__probe__echo', server_name: 'probe' }]
            }
        })

        expect(details).toMatchObject({
            provider: 'claude',
            model: 'claude-sonnet',
            contextWindow: 262_144,
            usage: { contextTokens: 26_697 },
            claude: {
                systemTools: ['Read', 'Bash'],
                slashCommands: ['/context', '/compact'],
                skills: [{ name: 'find-docs' }],
                mcpTools: [{ name: 'mcp__probe__echo', serverName: 'probe' }]
            }
        })
        expect(details?.claude).not.toHaveProperty('categories')
        expect(details?.claude).not.toHaveProperty('memoryFiles')
        expect(details?.claude).not.toHaveProperty('agents')
        expect(JSON.stringify(details)).not.toContain('prompt')
    })

    it('can seed usage from a result when /context has not been requested', () => {
        const details = buildClaudeContextDetails({
            updatedAt: 100,
            result: {
                model: 'claude-opus',
                usage: { input_tokens: 4_000, output_tokens: 500, cache_read_input_tokens: 3_000, cache_creation_input_tokens: 100 },
                modelUsage: {
                    'claude-opus': { contextWindow: 200_000 }
                }
            }
        })

        expect(details).toMatchObject({
            model: 'claude-opus',
            contextWindow: 200_000,
            usage: { cacheReadTokens: 3_000 }
        })
    })

    it('selects the session model instead of the first subagent model', () => {
        const details = buildClaudeContextDetails({
            updatedAt: 100,
            model: 'claude-opus',
            result: {
                modelUsage: {
                    'claude-haiku-subagent': { contextWindow: 200_000 },
                    'claude-opus': { contextWindow: 1_000_000 }
                }
            }
        })

        expect(details).toMatchObject({
            model: 'claude-opus',
            contextWindow: 1_000_000
        })
    })
})

describe('Codex context details', () => {
    it('normalizes last and cumulative usage plus runtime inventories', () => {
        const details = buildCodexContextDetails({
            updatedAt: 100,
            info: {
                modelContextWindow: 258_400,
                contextTokens: 11_000,
                last: {
                inputTokens: 11_000,
                cachedInputTokens: 8_000,
                cacheWriteInputTokens: 200,
                    outputTokens: 900,
                    reasoningOutputTokens: 300,
                    totalTokens: 11_900
                },
                total: {
                    inputTokens: 22_000,
                    cachedInputTokens: 16_000,
                    outputTokens: 1_800,
                    totalTokens: 23_800
                }
            },
            model: 'gpt-5.6-codex',
                threadResponse: {
                model: 'gpt-5.6-codex',
                instructionSources: ['/home/user/AGENTS.md'],
                thread: { id: 'thread-1' }
            },
                threadParams: { model: 'gpt-5.6-codex' },
            slashCommands: ['clear', '/compact', 'clear'],
            skills: [{
                name: 'find-docs',
                description: 'Find docs',
                path: '/home/user/.codex/skills/find-docs/SKILL.md',
                scope: 'user',
                enabled: true
            }],
            mcpServers: {
                hapi: {
                    command: 'node',
                    args: ['mcp'],
                    tools: { change_title: {}, list_peers: {} }
                }
            }
        })

        expect(details).toMatchObject({
            provider: 'codex',
            model: 'gpt-5.6-codex',
            contextWindow: 258_400,
            usage: { contextTokens: 11_000, cacheReadTokens: 8_000 },
            codex: {
                slashCommands: ['clear', '/compact'],
                skills: [{ name: 'find-docs' }],
                mcpServers: [{ name: 'hapi', toolNames: ['change_title', 'list_peers'] }]
            }
        })
    })

    it('normalizes the standard snake_case last token usage event', () => {
        const details = buildCodexContextDetails({
            updatedAt: 100,
            info: {
                last_token_usage: {
                    input_tokens: 12_000,
                    cached_input_tokens: 9_000
                }
            }
        })

        expect(details.usage).toEqual({
            contextTokens: 12_000,
            cacheReadTokens: 9_000
        })
    })

    it('includes configured MCP inventories alongside the injected bridge', () => {
        const details = buildCodexContextDetails({
            updatedAt: 100,
            mcpServers: { hapi: { command: 'hapi', args: ['mcp'], tools: { change_title: {} } } },
            mcpServerInventory: [{
                name: 'qmd',
                status: 'ready',
                toolNames: ['search']
            }]
        })

        expect(details.codex?.mcpServers).toEqual([
            { name: 'qmd', status: 'ready', toolNames: ['search'] },
            { name: 'hapi', toolNames: ['change_title'] }
        ])
    })
})

describe('mergeContextDetails', () => {
    it('keeps static provider details while replacing newer usage values', () => {
        const first = buildCodexContextDetails({
            updatedAt: 100,
            info: { modelContextWindow: 100_000, last: { inputTokens: 10 } },
            model: 'gpt-5',
            threadResponse: { modelProvider: 'openai', instructionSources: ['AGENTS.md'] },
            threadParams: { sandbox: 'workspace-write' },
            mcpServers: { hapi: { command: 'node', args: ['mcp'] } }
        })
        const second = buildCodexContextDetails({
            updatedAt: 200,
            info: { modelContextWindow: 100_000, last: { inputTokens: 20 } },
            model: 'gpt-5',
            threadId: 'thread-1'
        })
        const merged = mergeContextDetails(first, second)

        expect(merged.updatedAt).toBe(200)
        expect(merged.usage?.contextTokens).toBe(20)
        expect(merged.codex?.mcpServers).toEqual([{ name: 'hapi' }])
    })

    it('compacts obsolete provider fields when updating existing metadata', () => {
        const legacy = {
            version: 1,
            updatedAt: 100,
            provider: 'codex',
            codex: {
                sandbox: 'workspace-write',
                instructionSources: ['AGENTS.md'],
                skills: [{
                    name: 'find-docs',
                    scope: 'user',
                    path: '/home/user/.codex/skills/find-docs/SKILL.md',
                    description: 'Find docs'
                }]
            }
        } as unknown as ContextDetails
        const next = buildCodexContextDetails({
            updatedAt: 200,
            model: 'gpt-5',
            slashCommands: ['clear']
        })

        const compacted = mergeContextDetails(legacy, next)

        expect(compacted.codex?.skills).toEqual([{ name: 'find-docs' }])
        expect(JSON.stringify(compacted)).not.toContain('workspace-write')
        expect(JSON.stringify(compacted)).not.toContain('AGENTS.md')
        expect(JSON.stringify(compacted)).not.toContain('Find docs')
    })

    it('allows Codex refreshes to clear authoritative empty inventories', () => {
        const first = buildCodexContextDetails({
            updatedAt: 100,
            slashCommands: ['/compact'],
            skills: [{
                name: 'find-docs',
                description: 'Find docs',
                path: '/home/user/.codex/skills/find-docs/SKILL.md',
                scope: 'user',
                enabled: true
            }],
            mcpServers: { hapi: { command: 'node', args: ['mcp'], tools: { echo: {} } } }
        })
        const second = buildCodexContextDetails({
            updatedAt: 200,
            slashCommands: [],
            skills: [],
            mcpServers: {}
        })

        const merged = mergeContextDetails(first, second)

        expect(merged.codex).toEqual({ slashCommands: [], skills: [], mcpServers: [] })
    })

    it('allows Claude refreshes to clear authoritative empty inventories', () => {
        const first = buildClaudeContextDetails({
            updatedAt: 100,
            model: 'claude-opus',
            system: {
                tools: ['Read'],
                skills: ['find-docs'],
                slash_commands: ['/compact']
            },
            contextUsage: {
                mcp_tools: [{ name: 'mcp__qmd__search', server_name: 'qmd' }]
            }
        })!
        const second = buildClaudeContextDetails({
            updatedAt: 200,
            model: 'claude-opus',
            system: {
                tools: [],
                skills: [],
                slash_commands: []
            },
            contextUsage: { mcp_tools: [] }
        })!

        const merged = mergeContextDetails(first, second)

        expect(merged.claude).toEqual({
            skills: [],
            mcpTools: [],
            systemTools: [],
            slashCommands: []
        })
    })

    it('merges from the metadata value when queued publishers are applied later', () => {
        const updates: Array<(metadata: Metadata) => Metadata> = []
        const client = {
            updateMetadata: (handler: (metadata: Metadata) => Metadata) => {
                updates.push(handler)
            }
        }

        publishContextDetails(client, buildClaudeContextDetails({
            updatedAt: 100,
            model: 'claude-opus',
            system: { tools: ['Read'] }
        })!)
        publishContextDetails(client, buildClaudeContextDetails({
            updatedAt: 200,
            model: 'claude-opus',
            messageUsage: { contextTokens: 12_000 }
        })!)

        let metadata = {} as Metadata
        for (const update of updates) {
            metadata = update(metadata)
        }

        expect(metadata.contextDetails).toMatchObject({
            usage: { contextTokens: 12_000 },
            claude: { systemTools: ['Read'] }
        })
    })
})
