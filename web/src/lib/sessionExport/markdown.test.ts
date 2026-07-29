import { describe, expect, it } from 'vitest'
import { serializeSessionMarkdown } from './markdown'
import type { HapiSessionExport } from '@hapi/protocol/sessionExport'

function makeExport(
    messages: HapiSessionExport['messages'],
    scratchlist: HapiSessionExport['scratchlist'] = []
): HapiSessionExport {
    return {
        schemaVersion: 2,
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
            serviceTier: null,
            permissionMode: 'default',
            collaborationMode: 'default'
        },
        messages,
        scratchlist
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

    it('renders a Scratchlist section with text and attachment metadata', () => {
        const markdown = serializeSessionMarkdown(makeExport([], [
            {
                entryId: 'entry-1',
                text: 'Remember to file the ticket',
                createdAt: Date.UTC(2026, 5, 5, 10, 30, 0),
                updatedAt: Date.UTC(2026, 5, 5, 10, 31, 0),
                attachments: [{
                    id: 'att-1',
                    filename: 'sketch.png',
                    mimeType: 'image/png',
                    size: 128,
                    path: 'hapi-hub:scratchlist/att-1'
                }]
            },
            {
                entryId: 'entry-2',
                text: 'Empty attachments ok',
                createdAt: Date.UTC(2026, 5, 5, 10, 32, 0),
                updatedAt: Date.UTC(2026, 5, 5, 10, 32, 0),
                attachments: []
            }
        ]))

        expect(markdown).toContain('## Scratchlist')
        expect(markdown).toContain('Remember to file the ticket')
        expect(markdown).toContain('Empty attachments ok')
        expect(markdown).toContain('- Attachment: sketch.png (image/png, 128 bytes)')
        expect(markdown).toContain('scratchlistCount: 2')
    })

    it('omits the Scratchlist section when there are no notes', () => {
        const markdown = serializeSessionMarkdown(makeExport([]))

        expect(markdown).not.toContain('## Scratchlist')
        expect(markdown).toContain('scratchlistCount: 0')
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
