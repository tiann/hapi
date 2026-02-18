import { describe, expect, it } from 'vitest'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { normalizeAgentRecord } from '@/chat/normalizeAgent'
import { normalizeUserRecord } from '@/chat/normalizeUser'
import type { DecryptedMessage } from '@/types/api'

function makeMessage(content: unknown, overrides: Partial<DecryptedMessage> = {}): DecryptedMessage {
    return {
        id: 'msg-1',
        seq: 1,
        localId: null,
        content,
        createdAt: 1700000000000,
        ...overrides
    }
}

describe('normalizeDecryptedMessage', () => {
    it('falls back to safe stringification when content is not role wrapped', () => {
        const content = { unexpected: true, nested: { value: 1 } }
        const message = makeMessage(content, {
            id: 'msg-fallback',
            localId: 'local-fallback',
            status: 'failed',
            originalText: 'raw payload'
        })

        expect(normalizeDecryptedMessage(message)).toEqual({
            id: 'msg-fallback',
            localId: 'local-fallback',
            createdAt: 1700000000000,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'text',
                text: JSON.stringify(content, null, 2),
                uuid: 'msg-fallback',
                parentUUID: null
            }],
            status: 'failed',
            originalText: 'raw payload'
        })
    })

    it('normalizes user role content on the happy path', () => {
        const message = makeMessage({
            role: 'user',
            content: 'hello from user',
            meta: { source: 'web' }
        }, {
            id: 'msg-user-ok',
            status: 'sent',
            originalText: 'hello from user'
        })

        expect(normalizeDecryptedMessage(message)).toEqual({
            id: 'msg-user-ok',
            localId: null,
            createdAt: 1700000000000,
            role: 'user',
            isSidechain: false,
            content: { type: 'text', text: 'hello from user' },
            meta: { source: 'web' },
            status: 'sent',
            originalText: 'hello from user'
        })
    })

    it('falls back when a user record cannot be normalized', () => {
        const invalidContent = { type: 'unsupported', payload: { bad: true } }
        const message = makeMessage({
            role: 'user',
            content: invalidContent,
            meta: { source: 'bad-client' }
        }, {
            id: 'msg-user-fallback'
        })

        expect(normalizeDecryptedMessage(message)).toEqual({
            id: 'msg-user-fallback',
            localId: null,
            createdAt: 1700000000000,
            role: 'user',
            isSidechain: false,
            content: {
                type: 'text',
                text: JSON.stringify(invalidContent, null, 2)
            },
            meta: { source: 'bad-client' },
            status: undefined,
            originalText: undefined
        })
    })

    it('returns null for skippable agent output payloads', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    isMeta: true,
                    message: { content: 'ignored' }
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toBeNull()
    })
})

describe('normalizeAgentRecord', () => {
    it('normalizes assistant output text/thinking/tool_use blocks and usage', () => {
        const normalized = normalizeAgentRecord(
            'msg-assistant',
            'local-assistant',
            123,
            {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'assistant-uuid',
                    parentUuid: 'assistant-parent',
                    message: {
                        content: [
                            { type: 'text', text: 'assistant text' },
                            { type: 'thinking', thinking: 'assistant thought' },
                            {
                                type: 'tool_use',
                                id: 'tool-call-1',
                                name: 'Read',
                                input: { description: 'read file', path: 'README.md' }
                            },
                            { type: 'ignored', value: true }
                        ],
                        usage: {
                            input_tokens: 101,
                            output_tokens: 202,
                            cache_creation_input_tokens: 3,
                            cache_read_input_tokens: 4,
                            service_tier: 'priority'
                        }
                    }
                }
            },
            { model: 'claude' }
        )

        expect(normalized).toEqual({
            id: 'msg-assistant',
            localId: 'local-assistant',
            createdAt: 123,
            role: 'agent',
            isSidechain: false,
            content: [
                {
                    type: 'text',
                    text: 'assistant text',
                    uuid: 'assistant-uuid',
                    parentUUID: 'assistant-parent'
                },
                {
                    type: 'reasoning',
                    text: 'assistant thought',
                    uuid: 'assistant-uuid',
                    parentUUID: 'assistant-parent'
                },
                {
                    type: 'tool-call',
                    id: 'tool-call-1',
                    name: 'Read',
                    input: { description: 'read file', path: 'README.md' },
                    description: 'read file',
                    uuid: 'assistant-uuid',
                    parentUUID: 'assistant-parent'
                }
            ],
            meta: { model: 'claude' },
            usage: {
                input_tokens: 101,
                output_tokens: 202,
                cache_creation_input_tokens: 3,
                cache_read_input_tokens: 4,
                service_tier: 'priority'
            }
        })
    })

    it('normalizes output user sidechain messages', () => {
        const normalized = normalizeAgentRecord(
            'msg-sidechain',
            null,
            456,
            {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'sidechain-uuid',
                    isSidechain: true,
                    message: {
                        content: 'follow-up command'
                    }
                }
            }
        )

        expect(normalized).toEqual({
            id: 'msg-sidechain',
            localId: null,
            createdAt: 456,
            role: 'agent',
            isSidechain: true,
            content: [{
                type: 'sidechain',
                uuid: 'sidechain-uuid',
                prompt: 'follow-up command'
            }]
        })
    })

    it('normalizes tool_result permissions when valid', () => {
        const normalized = normalizeAgentRecord(
            'msg-tool-valid',
            null,
            789,
            {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'tool-uuid',
                    parentUuid: 'tool-parent',
                    toolUseResult: { from: 'embedded' },
                    message: {
                        content: [{
                            type: 'tool_result',
                            tool_use_id: 'call-valid',
                            content: { from: 'block' },
                            is_error: false,
                            permissions: {
                                date: 1700000000000,
                                result: 'approved',
                                mode: 'acceptEdits',
                                allowedTools: ['Read', 99, 'Write'],
                                decision: 'approved_for_session'
                            }
                        }]
                    }
                }
            }
        )

        expect(normalized).toEqual({
            id: 'msg-tool-valid',
            localId: null,
            createdAt: 789,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-result',
                tool_use_id: 'call-valid',
                content: { from: 'embedded' },
                is_error: false,
                uuid: 'tool-uuid',
                parentUUID: 'tool-parent',
                permissions: {
                    date: 1700000000000,
                    result: 'approved',
                    mode: 'acceptEdits',
                    allowedTools: ['Read', 'Write'],
                    decision: 'approved_for_session'
                }
            }]
        })
    })

    it('drops invalid tool_result permissions (bad date/result)', () => {
        const normalized = normalizeAgentRecord(
            'msg-tool-invalid',
            null,
            790,
            {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'tool-invalid-uuid',
                    message: {
                        content: [
                            {
                                type: 'tool_result',
                                tool_use_id: 'call-bad-date',
                                content: { ok: false },
                                permissions: {
                                    date: 'not-a-number',
                                    result: 'approved'
                                }
                            },
                            {
                                type: 'tool_result',
                                tool_use_id: 'call-bad-result',
                                content: { ok: false },
                                permissions: {
                                    date: 1700000000001,
                                    result: 'maybe'
                                }
                            }
                        ]
                    }
                }
            }
        )

        expect(normalized).toEqual({
            id: 'msg-tool-invalid',
            localId: null,
            createdAt: 790,
            role: 'agent',
            isSidechain: false,
            content: [
                {
                    type: 'tool-result',
                    tool_use_id: 'call-bad-date',
                    content: { ok: false },
                    is_error: false,
                    uuid: 'tool-invalid-uuid',
                    parentUUID: null,
                    permissions: undefined
                },
                {
                    type: 'tool-result',
                    tool_use_id: 'call-bad-result',
                    content: { ok: false },
                    is_error: false,
                    uuid: 'tool-invalid-uuid',
                    parentUUID: null,
                    permissions: undefined
                }
            ]
        })
    })

    it('normalizes codex message records', () => {
        expect(normalizeAgentRecord(
            'msg-codex-message',
            null,
            901,
            {
                type: 'codex',
                data: {
                    type: 'message',
                    message: 'codex message text'
                }
            }
        )).toEqual({
            id: 'msg-codex-message',
            localId: null,
            createdAt: 901,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'text',
                text: 'codex message text',
                uuid: 'msg-codex-message',
                parentUUID: null
            }]
        })
    })

    it('normalizes codex reasoning records', () => {
        expect(normalizeAgentRecord(
            'msg-codex-reasoning',
            null,
            902,
            {
                type: 'codex',
                data: {
                    type: 'reasoning',
                    message: 'codex reasoning text'
                }
            }
        )).toEqual({
            id: 'msg-codex-reasoning',
            localId: null,
            createdAt: 902,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'reasoning',
                text: 'codex reasoning text',
                uuid: 'msg-codex-reasoning',
                parentUUID: null
            }]
        })
    })

    it('normalizes codex tool-call records', () => {
        expect(normalizeAgentRecord(
            'msg-codex-tool',
            'local-codex-tool',
            903,
            {
                type: 'codex',
                data: {
                    type: 'tool-call',
                    callId: 'codex-call-1',
                    id: 'codex-tool-uuid',
                    name: 'Bash',
                    input: { command: 'ls -la' }
                }
            }
        )).toEqual({
            id: 'msg-codex-tool',
            localId: 'local-codex-tool',
            createdAt: 903,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-call',
                id: 'codex-call-1',
                name: 'Bash',
                input: { command: 'ls -la' },
                description: null,
                uuid: 'codex-tool-uuid',
                parentUUID: null
            }]
        })
    })

    it('normalizes codex plan records into TodoWrite tool-call/result blocks', () => {
        const normalized = normalizeAgentRecord(
            'msg-codex-plan',
            null,
            904,
            {
                type: 'codex',
                data: {
                    type: 'plan',
                    entries: [
                        { id: 'todo-1', content: 'first task', status: 'pending' },
                        { content: 'second task', status: 'in_progress' },
                        { id: 'todo-3', content: 'bad task', status: 'blocked' },
                        { not: 'an-entry' }
                    ]
                }
            }
        )

        expect(normalized).toEqual({
            id: 'msg-codex-plan',
            localId: null,
            createdAt: 904,
            role: 'agent',
            isSidechain: false,
            content: [
                {
                    type: 'tool-call',
                    id: 'codex-plan-msg-codex-plan',
                    name: 'TodoWrite',
                    input: {
                        todos: [
                            { id: 'todo-1', content: 'first task', status: 'pending' },
                            { id: 'plan-2', content: 'second task', status: 'in_progress' }
                        ]
                    },
                    description: null,
                    uuid: 'msg-codex-plan',
                    parentUUID: null
                },
                {
                    type: 'tool-result',
                    tool_use_id: 'codex-plan-msg-codex-plan',
                    content: { success: true },
                    is_error: false,
                    uuid: 'msg-codex-plan',
                    parentUUID: null
                }
            ]
        })
    })
})

describe('normalizeUserRecord', () => {
    it('filters invalid attachments and preserves previewUrl', () => {
        const normalized = normalizeUserRecord(
            'msg-user-attachments',
            'local-user-attachments',
            1000,
            {
                type: 'text',
                text: 'message with files',
                attachments: [
                    {
                        id: 'att-1',
                        filename: 'image.png',
                        mimeType: 'image/png',
                        size: 123,
                        path: '/tmp/image.png',
                        previewUrl: '/preview/image.png'
                    },
                    {
                        id: 'att-2',
                        filename: 'notes.txt',
                        mimeType: 'text/plain',
                        size: 42,
                        path: '/tmp/notes.txt'
                    },
                    {
                        id: 'bad-1',
                        filename: 'bad.txt',
                        mimeType: 'text/plain',
                        size: '42',
                        path: '/tmp/bad.txt'
                    },
                    {
                        id: 'bad-2',
                        filename: 'missing-path.txt',
                        mimeType: 'text/plain',
                        size: 5
                    }
                ]
            },
            { source: 'upload' }
        )

        expect(normalized).toEqual({
            id: 'msg-user-attachments',
            localId: 'local-user-attachments',
            createdAt: 1000,
            role: 'user',
            content: {
                type: 'text',
                text: 'message with files',
                attachments: [
                    {
                        id: 'att-1',
                        filename: 'image.png',
                        mimeType: 'image/png',
                        size: 123,
                        path: '/tmp/image.png',
                        previewUrl: '/preview/image.png'
                    },
                    {
                        id: 'att-2',
                        filename: 'notes.txt',
                        mimeType: 'text/plain',
                        size: 42,
                        path: '/tmp/notes.txt',
                        previewUrl: undefined
                    }
                ]
            },
            isSidechain: false,
            meta: { source: 'upload' }
        })
    })
})
