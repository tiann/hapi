import { describe, expect, it } from 'vitest'
import { serializeSessionMarkdown } from './markdown'
import type { HapiSessionExport } from '@hapi/protocol/sessionExport'

function makeExport(messages: HapiSessionExport['messages']): HapiSessionExport {
    return {
        schemaVersion: 1,
        exportedAt: Date.UTC(2026, 5, 5, 12, 0, 0),
        session: {
            id: 'session-abcdef123456',
            namespace: 'default',
            seq: 1,
            createdAt: Date.UTC(2026, 5, 5, 10, 0, 0),
            updatedAt: Date.UTC(2026, 5, 5, 11, 0, 0),
            active: false,
            activeAt: Date.UTC(2026, 5, 5, 11, 0, 0),
            metadata: {
                path: '/tmp/project',
                host: 'workstation',
                name: 'Export Demo',
                flavor: 'codex'
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: Date.UTC(2026, 5, 5, 11, 0, 0),
            model: null,
            modelReasoningEffort: null,
            effort: null,
            permissionMode: 'default',
            collaborationMode: 'default'
        },
        messages
    }
}

describe('serializeSessionMarkdown', () => {
    it('serializes user and assistant messages from one export payload', () => {
        const markdown = serializeSessionMarkdown(makeExport([
            {
                id: 'msg-1',
                seq: 1,
                localId: null,
                createdAt: Date.UTC(2026, 5, 5, 10, 1, 0),
                invokedAt: Date.UTC(2026, 5, 5, 10, 1, 1),
                scheduledAt: null,
                content: { role: 'user', content: 'Hello **HAPI**' }
            },
            {
                id: 'msg-2',
                seq: 2,
                localId: null,
                createdAt: Date.UTC(2026, 5, 5, 10, 2, 0),
                invokedAt: Date.UTC(2026, 5, 5, 10, 2, 0),
                scheduledAt: null,
                content: { role: 'agent', content: 'Hi there' }
            }
        ]))

        expect(markdown).toContain('title: "Export Demo"')
        expect(markdown).toContain('# Export Demo')
        expect(markdown).toContain('## User')
        expect(markdown).toContain('Hello **HAPI**')
        expect(markdown).toContain('## Assistant')
        expect(markdown).toContain('Hi there')
    })

    it('escapes newlines and quotes in YAML front matter metadata', () => {
        const markdown = serializeSessionMarkdown({
            ...makeExport([]),
            session: {
                ...makeExport([]).session,
                metadata: {
                    path: '/tmp/line\nbreak',
                    host: 'host"quote',
                    name: 'Title\nwith"newline'
                }
            }
        })

        expect(markdown).toContain('title: "Title\\nwith\\"newline"')
        expect(markdown).toContain('path: "/tmp/line\\nbreak"')
        expect(markdown).toContain('host: "host\\"quote"')
        expect(markdown).toMatch(/^---\n[\s\S]*\n---\n/)
    })

    it('skips messages that normalize to null and summarizes tool calls', () => {
        const markdown = serializeSessionMarkdown(makeExport([
            {
                id: 'skip-1',
                seq: 1,
                localId: null,
                createdAt: 1,
                invokedAt: 1,
                scheduledAt: null,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: { type: 'system', subtype: 'init', uuid: 'sys-init' }
                    }
                }
            },
            {
                id: 'tool-1',
                seq: 2,
                localId: null,
                createdAt: 2,
                invokedAt: 2,
                scheduledAt: null,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'assistant-1',
                            message: {
                                content: [
                                    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'bun test' } }
                                ]
                            }
                        }
                    }
                }
            }
        ]))

        expect(markdown).not.toContain('sys-init')
        expect(markdown).toContain('- Tool: Bash')
    })
})
