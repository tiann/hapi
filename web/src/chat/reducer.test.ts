import { describe, expect, it } from 'vitest'
import { reduceChatBlocks } from './reducer'
import type { NormalizedMessage } from './types'

describe('reduceChatBlocks', () => {
    it('keeps Hermes MoA references as standalone collapsible blocks', () => {
        const messages: NormalizedMessage[] = [{
            id: 'msg-moa-ref',
            localId: null,
            createdAt: 1_700_000_000_100,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'moa-reference',
                label: 'openai-codex:gpt-5.5',
                text: 'reference output',
                index: 1,
                count: 3,
                uuid: 'u-moa-ref',
                parentUUID: null
            }]
        }]

        const { blocks } = reduceChatBlocks(messages, null)

        expect(blocks).toEqual([{
            kind: 'moa-reference',
            id: 'msg-moa-ref:0',
            localId: null,
            createdAt: 1_700_000_000_100,
            label: 'openai-codex:gpt-5.5',
            text: 'reference output',
            index: 1,
            count: 3,
            meta: undefined
        }])
    })

    it('keeps send_attachment tool evidence when no attachment payload survived normalization', () => {
        const messages: NormalizedMessage[] = [{
            id: 'msg-tool-call',
            localId: null,
            createdAt: 1_700_000_000_100,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-call',
                id: 'tool-attach',
                name: 'mcp__hapi__send_attachment',
                input: { files: [{ path: 'missing.png' }] },
                description: null,
                uuid: 'u-tool',
                parentUUID: null
            }]
        }, {
            id: 'msg-tool-result',
            localId: null,
            createdAt: 1_700_000_000_200,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-result',
                tool_use_id: 'tool-attach',
                content: 'Sent 1 attachment to the user.',
                is_error: false,
                uuid: 'u-result',
                parentUUID: null
            }]
        }]

        const { blocks } = reduceChatBlocks(messages, null)

        expect(blocks).toHaveLength(1)
        expect(blocks[0]).toMatchObject({
            kind: 'tool-call',
            id: 'tool-attach',
            tool: {
                id: 'tool-attach',
                name: 'mcp__hapi__send_attachment',
                state: 'completed',
                result: 'Sent 1 attachment to the user.'
            }
        })
    })

    it('suppresses send_attachment tool evidence when the attachment payload is visible', () => {
        const attachment = {
            id: 'agent-att-1',
            filename: 'chart.png',
            mimeType: 'image/png',
            size: 4,
            path: 'hapi-agent-inline://agent-att-1/chart.png',
            previewUrl: 'data:image/png;base64,AAAA'
        }
        const messages: NormalizedMessage[] = [{
            id: 'msg-tool-call',
            localId: null,
            createdAt: 1_700_000_000_100,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-call',
                id: 'tool-attach',
                name: 'functions.hapi__send_attachment',
                input: { files: [{ path: 'chart.png' }] },
                description: null,
                uuid: 'u-tool',
                parentUUID: null
            }]
        }, {
            id: 'msg-tool-result',
            localId: null,
            createdAt: 1_700_000_000_200,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-result',
                tool_use_id: 'tool-attach',
                content: 'Sent 1 attachment to the user.',
                is_error: false,
                uuid: 'u-result',
                parentUUID: null
            }]
        }, {
            id: 'msg-attachments',
            localId: null,
            createdAt: 1_700_000_000_300,
            role: 'agent',
            isSidechain: false,
            content: [{ type: 'attachments', attachments: [attachment], uuid: 'u-att', parentUUID: null }]
        }]

        const { blocks } = reduceChatBlocks(messages, null)

        expect(blocks).toHaveLength(1)
        expect(blocks[0]).toMatchObject({
            kind: 'agent-attachments',
            attachments: [attachment]
        })
    })

    it('only suppresses the send_attachment tool call paired with a visible attachment payload', () => {
        const attachment = {
            id: 'agent-att-1',
            filename: 'chart.png',
            mimeType: 'image/png',
            size: 4,
            path: 'hapi-agent-inline://agent-att-1/chart.png',
            previewUrl: 'data:image/png;base64,AAAA'
        }
        const messages: NormalizedMessage[] = [{
            id: 'msg-tool-call-1',
            localId: null,
            createdAt: 1_700_000_000_100,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-call',
                id: 'tool-visible',
                name: 'happy__send_attachment',
                input: { files: [{ path: 'chart.png' }] },
                description: null,
                uuid: 'u-tool-1',
                parentUUID: null
            }]
        }, {
            id: 'msg-attachments',
            localId: null,
            createdAt: 1_700_000_000_200,
            role: 'agent',
            isSidechain: false,
            content: [{ type: 'attachments', attachments: [attachment], uuid: 'u-att', parentUUID: null }]
        }, {
            id: 'msg-tool-result-1',
            localId: null,
            createdAt: 1_700_000_000_300,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-result',
                tool_use_id: 'tool-visible',
                content: 'Sent 1 attachment to the user.',
                is_error: false,
                uuid: 'u-result-1',
                parentUUID: null
            }]
        }, {
            id: 'msg-tool-call-2',
            localId: null,
            createdAt: 1_700_000_000_400,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-call',
                id: 'tool-missing',
                name: 'mcp__hapi__send_attachment',
                input: { files: [{ path: 'missing.png' }] },
                description: null,
                uuid: 'u-tool-2',
                parentUUID: null
            }]
        }, {
            id: 'msg-tool-result-2',
            localId: null,
            createdAt: 1_700_000_000_500,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-result',
                tool_use_id: 'tool-missing',
                content: 'Failed to send attachment: missing.png',
                is_error: true,
                uuid: 'u-result-2',
                parentUUID: null
            }]
        }]

        const { blocks } = reduceChatBlocks(messages, null)

        expect(blocks).toHaveLength(2)
        expect(blocks[0]).toMatchObject({
            kind: 'agent-attachments',
            attachments: [attachment]
        })
        expect(blocks[1]).toMatchObject({
            kind: 'tool-call',
            id: 'tool-missing',
            tool: {
                id: 'tool-missing',
                name: 'mcp__hapi__send_attachment',
                state: 'error',
                result: 'Failed to send attachment: missing.png'
            }
        })
    })

    it('does not pair a later visible attachment payload with an earlier failed send_attachment call', () => {
        const attachment = {
            id: 'agent-att-1',
            filename: 'chart.png',
            mimeType: 'image/png',
            size: 4,
            path: 'hapi-agent-inline://agent-att-1/chart.png',
            previewUrl: 'data:image/png;base64,AAAA'
        }
        const messages: NormalizedMessage[] = [{
            id: 'msg-tool-call-failed',
            localId: null,
            createdAt: 1_700_000_000_100,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-call',
                id: 'tool-failed',
                name: 'mcp__hapi__send_attachment',
                input: { files: [{ path: 'missing.png' }] },
                description: null,
                uuid: 'u-tool-failed',
                parentUUID: null
            }]
        }, {
            id: 'msg-tool-result-failed',
            localId: null,
            createdAt: 1_700_000_000_200,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-result',
                tool_use_id: 'tool-failed',
                content: 'Failed to send attachment: missing.png',
                is_error: true,
                uuid: 'u-result-failed',
                parentUUID: null
            }]
        }, {
            id: 'msg-tool-call-visible',
            localId: null,
            createdAt: 1_700_000_000_300,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-call',
                id: 'tool-visible',
                name: 'mcp__hapi__send_attachment',
                input: { files: [{ path: 'chart.png' }] },
                description: null,
                uuid: 'u-tool-visible',
                parentUUID: null
            }]
        }, {
            id: 'msg-tool-result-visible',
            localId: null,
            createdAt: 1_700_000_000_400,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-result',
                tool_use_id: 'tool-visible',
                content: 'Sent 1 attachment to the user.',
                is_error: false,
                uuid: 'u-result-visible',
                parentUUID: null
            }]
        }, {
            id: 'msg-attachments',
            localId: null,
            createdAt: 1_700_000_000_500,
            role: 'agent',
            isSidechain: false,
            content: [{ type: 'attachments', attachments: [attachment], uuid: 'u-att', parentUUID: null }]
        }]

        const { blocks } = reduceChatBlocks(messages, null)

        expect(blocks).toHaveLength(2)
        expect(blocks[0]).toMatchObject({
            kind: 'tool-call',
            id: 'tool-failed',
            tool: {
                id: 'tool-failed',
                state: 'error',
                result: 'Failed to send attachment: missing.png'
            }
        })
        expect(blocks[1]).toMatchObject({
            kind: 'agent-attachments',
            attachments: [attachment]
        })
    })
})
