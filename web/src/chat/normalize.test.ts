import { describe, expect, it } from 'vitest'
import { normalizeDecryptedMessage } from './normalize'
import type { DecryptedMessage } from '@/types/api'

function makeMessage(content: unknown): DecryptedMessage {
    return {
        id: 'msg-1',
        seq: 1,
        localId: null,
        content,
        createdAt: 1_742_372_800_000
    }
}

describe('normalizeDecryptedMessage', () => {
    it('drops unsupported Claude system output records', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'stop_hook_summary',
                    uuid: 'sys-1'
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toBeNull()
    })

    it('drops Claude init system output records', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'init',
                    uuid: 'sys-init',
                    session_id: 'session-1'
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toBeNull()
    })

    it('keeps known Claude system subtypes as normalized events', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'turn_duration',
                    uuid: 'sys-2',
                    durationMs: 1200
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toMatchObject({
            id: 'msg-1',
            role: 'event',
            isSidechain: false,
            content: {
                type: 'turn-duration',
                durationMs: 1200
            }
        })
    })

    it('normalizes Claude compact boundary metadata into a compact event', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'compact_boundary',
                    uuid: 'sys-compact',
                    compactMetadata: {
                        trigger: 'auto',
                        preTokens: 1_003_310,
                        postTokens: 20_011,
                        durationMs: 146_000
                    }
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toMatchObject({
            id: 'msg-1',
            role: 'event',
            isSidechain: false,
            content: {
                type: 'compact',
                source: 'claude',
                trigger: 'auto',
                preTokens: 1_003_310,
                postTokens: 20_011,
                tokensSaved: 983_299,
                durationMs: 146_000
            }
        })
    })

    it('keeps the stringify fallback for unknown non-system agent payloads', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    foo: 'bar'
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            id: 'msg-1',
            role: 'agent',
            isSidechain: false
        })

        expect(normalized?.role).toBe('agent')
        if (!normalized || normalized.role !== 'agent') {
            throw new Error('Expected agent message')
        }
        const firstBlock = normalized.content[0]
        expect(firstBlock).toMatchObject({
            type: 'text',
        })
        if (firstBlock.type !== 'text') {
            throw new Error('Expected fallback text block')
        }
        expect(firstBlock.text).toContain('"foo": "bar"')
    })

    it('normalizes <task-notification> user output as sidechain (event extracted by reducer)', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u-notif',
                    message: { content: '<task-notification> <summary>Background command stopped</summary> </task-notification>' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        // Normalizer emits as sidechain (preserving uuid for sentinel detection);
        // the reducer extracts the summary as an event.
        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
        })
        if (normalized?.role === 'agent') {
            expect(normalized.content[0]).toMatchObject({
                type: 'sidechain',
                kind: 'background_notification',
                prompt: expect.stringContaining('<task-notification>')
            })
        }
    })

    it('keeps explicit internal messageKind metadata on sidechain records', () => {
        const message = makeMessage({
            role: 'agent',
            meta: { sentFrom: 'cli', messageKind: 'background_notification' },
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u-meta-notif',
                    message: { content: '<task-notification> <summary>Background command stopped</summary> </task-notification>' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
            meta: { messageKind: 'background_notification' }
        })
        if (normalized?.role === 'agent') {
            expect(normalized.content[0]).toMatchObject({
                type: 'sidechain',
                kind: 'background_notification'
            })
        }
    })

    it('treats <task-notification> without summary as sidechain (dropped by reducer)', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u3',
                    message: { content: '<task-notification> <status>killed</status> </task-notification>' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
        })
    })

    it('treats non-sidechain string user output as sidechain', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    isSidechain: false,
                    uuid: 'u1',
                    message: { content: 'This is a subagent prompt' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
        })
        if (normalized?.role !== 'agent') throw new Error('Expected agent')
        expect(normalized.content[0]).toMatchObject({
            type: 'sidechain',
            prompt: 'This is a subagent prompt'
        })
    })

    it('treats <system-reminder> user output as sidechain (dropped by reducer)', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u2',
                    message: { content: '<system-reminder>Some internal reminder</system-reminder>' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
        })
    })

    it('treats sidechain user output with array content as sidechain', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u3',
                    isSidechain: true,
                    message: { content: [{ type: 'text', text: 'This is an agent prompt in array form' }] }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
        })
        if (normalized?.role !== 'agent') throw new Error('Expected agent')
        expect(normalized.content[0]).toMatchObject({
            type: 'sidechain',
            prompt: 'This is an agent prompt in array form'
        })
    })

    it('keeps "No response requested." text in normalized output (filtered later by reducer)', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'a-1',
                    message: { role: 'assistant', content: 'No response requested.' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)
        // Normalizer preserves the text (uuid/parentUUID needed by tracer);
        // the reducer is responsible for suppressing it during rendering.
        expect(normalized).not.toBeNull()
        expect(normalized?.role).toBe('agent')
        if (normalized?.role === 'agent') {
            expect(normalized.content).toHaveLength(1)
            expect(normalized.content[0]).toMatchObject({ type: 'text', text: 'No response requested.' })
        }
    })

    it('keeps assistant messages with real content', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'a-2',
                    message: { role: 'assistant', content: 'Here is the answer.' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)
        expect(normalized).not.toBeNull()
        expect(normalized?.role).toBe('agent')
    })

    it('propagates parentUuid from assistant output data to text block parentUUID', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'a-3',
                    parentUuid: 'parent-injected-uuid',
                    message: { role: 'assistant', content: 'No response requested.' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)
        expect(normalized).not.toBeNull()
        if (normalized?.role !== 'agent') throw new Error('Expected agent')
        expect(normalized.content).toHaveLength(1)
        expect(normalized.content[0]).toMatchObject({
            type: 'text',
            text: 'No response requested.',
            parentUUID: 'parent-injected-uuid'
        })
    })

    it('sets parentUUID to null when parentUuid is absent in assistant output', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'a-4',
                    // No parentUuid field
                    message: { role: 'assistant', content: 'Hello.' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)
        expect(normalized).not.toBeNull()
        if (normalized?.role !== 'agent') throw new Error('Expected agent')
        expect(normalized.content[0]).toMatchObject({
            type: 'text',
            parentUUID: null
        })
    })

    it('normalizes non-sidechain text-only array-content user output as user message', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u5',
                    isSidechain: false,
                    message: { content: [{ type: 'text', text: 'Regular user message' }] }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'user',
            isSidechain: false,
            content: { type: 'text', text: 'Regular user message' }
        })
    })

    it('drops codex-synced subagent pseudo-user wrapper messages', () => {
        const message: DecryptedMessage = {
            ...makeMessage({
                role: 'user',
                content: {
                    type: 'text',
                    text: '<subagent_notification>\n{"status":"completed"}\n</subagent_notification>'
                }
            }),
            localId: 'codex:thread-1:12:abc123'
        }

        expect(normalizeDecryptedMessage(message)).toBeNull()
    })

    it('keeps wrapper-like user text when it is not a codex sync artifact', () => {
        const message = makeMessage({
            role: 'user',
            content: {
                type: 'text',
                text: '<subagent_notification>用户自己输入的文本</subagent_notification>'
            }
        })

        expect(normalizeDecryptedMessage(message)).toMatchObject({
            role: 'user',
            isSidechain: false,
            content: {
                type: 'text',
                text: '<subagent_notification>用户自己输入的文本</subagent_notification>'
            }
        })
    })

    it('sanitizes user attachment preview URLs while keeping attachment metadata', () => {
        const safe = {
            id: 'user-att-safe',
            filename: 'upload.png',
            mimeType: 'image/png',
            size: 8,
            path: 'hapi-upload://user-att-safe/upload.png',
            previewUrl: 'data:image/png;base64,iVBORw0KGgo='
        }
        const unsafe = {
            id: 'user-att-unsafe',
            filename: 'page.html',
            mimeType: 'text/html',
            size: 30,
            path: 'hapi-upload://user-att-unsafe/page.html',
            previewUrl: 'data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4='
        }
        const message = makeMessage({
            role: 'user',
            content: {
                type: 'text',
                text: 'Please inspect these files',
                attachments: [safe, unsafe, { ...safe, id: 'user-att-js', previewUrl: 'javascript:alert(1)' }]
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).not.toBeNull()
        if (normalized?.role !== 'user') throw new Error('Expected user')
        expect(normalized.content.attachments).toEqual([
            safe,
            {
                id: unsafe.id,
                filename: unsafe.filename,
                mimeType: unsafe.mimeType,
                size: unsafe.size,
                path: unsafe.path,
                previewUrl: undefined
            },
            {
                ...safe,
                id: 'user-att-js',
                previewUrl: undefined
            }
        ])
    })

    it('treats sidechain user output with mixed tool_result + text array as sidechain', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u6',
                    isSidechain: true,
                    message: { content: [
                        { type: 'tool_result', tool_use_id: 'tc-1', content: 'result' },
                        { type: 'text', text: 'Some subagent text' }
                    ] }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
        })
        if (normalized?.role !== 'agent') throw new Error('Expected agent')
        expect(normalized.content[0]).toMatchObject({
            type: 'sidechain',
            prompt: 'Some subagent text'
        })
    })

    it('normalizes codex agent attachment payloads', () => {
        const attachment = {
            id: 'agent-att-1',
            filename: 'report.csv',
            mimeType: 'text/csv',
            size: 8,
            path: 'hapi-agent-inline://agent-att-1/report.csv',
            previewUrl: 'data:text/csv;base64,YSxiCjEsMgo='
        }
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'attachments',
                    attachments: [attachment, { id: 'missing-required-fields' }]
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).not.toBeNull()
        if (normalized?.role !== 'agent') throw new Error('Expected agent')
        expect(normalized.content).toEqual([{
            type: 'attachments',
            attachments: [attachment],
            uuid: message.id,
            parentUUID: null
        }])
    })

    it('normalizes Codex native context_compacted events into compact events', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'context_compacted',
                    previousTokens: 230_305,
                    tokens: 30_470
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toMatchObject({
            id: 'msg-1',
            role: 'event',
            isSidechain: false,
            content: {
                type: 'compact',
                source: 'codex',
                preTokens: 230_305,
                postTokens: 30_470,
                tokensSaved: 199_835
            }
        })
    })

    it('keeps Codex native context_compacted events visible even without token details', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'context_compacted'
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toMatchObject({
            id: 'msg-1',
            role: 'event',
            isSidechain: false,
            content: {
                type: 'compact',
                source: 'codex'
            }
        })
    })

    it('drops codex agent attachments with unsafe preview URLs', () => {
        const safe = {
            id: 'agent-att-safe',
            filename: 'report.csv',
            mimeType: 'text/csv',
            size: 8,
            path: 'hapi-agent-inline://agent-att-safe/report.csv',
            previewUrl: 'data:text/csv;base64,YSxiCjEsMgo='
        }
        const unsafe = {
            id: 'agent-att-unsafe',
            filename: 'page.html',
            mimeType: 'text/html\u0000',
            size: 30,
            path: 'hapi-agent-inline://agent-att-unsafe/page.html',
            previewUrl: 'data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4='
        }
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'attachments',
                    attachments: [unsafe, safe, { ...safe, id: 'agent-att-js', previewUrl: 'javascript:alert(1)' }]
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).not.toBeNull()
        if (normalized?.role !== 'agent') throw new Error('Expected agent')
        expect(normalized.content).toEqual([{
            type: 'attachments',
            attachments: [safe],
            uuid: message.id,
            parentUUID: null
        }])
    })

    it('preserves codex tool-call-result error state', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call-result',
                    callId: 'call-failed',
                    output: 'permission denied',
                    is_error: true
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).not.toBeNull()
        if (normalized?.role !== 'agent') throw new Error('Expected agent')
        expect(normalized.content).toEqual([{
            type: 'tool-result',
            tool_use_id: 'call-failed',
            content: 'permission denied',
            is_error: true,
            uuid: message.id,
            parentUUID: null
        }])
    })

    it('keeps Grok plan, error, and unknown extension payloads visible', () => {
        const plan = normalizeDecryptedMessage(makeMessage({ role: 'agent', content: {
            type: 'codex', data: { type: 'plan', entries: [{ content: 'Do work', status: 'pending', priority: 'high' }] }
        } }))
        expect(plan).toMatchObject({ role: 'agent', content: [{ type: 'text', text: 'Plan updated:\n- [ ] Do work' }] })

        const error = normalizeDecryptedMessage(makeMessage({ role: 'agent', content: {
            type: 'codex', data: { type: 'error', message: 'failed' }
        } }))
        expect(error).toMatchObject({ role: 'agent', content: [{ type: 'text', text: 'Grok error: failed' }] })

        const extension = normalizeDecryptedMessage(makeMessage({ role: 'agent', content: {
            type: 'codex', data: { type: 'grok-extension', method: '_x.ai/future', params: { value: 1 } }
        } }))
        expect(extension).toMatchObject({ role: 'event', content: { type: 'grok-extension', method: '_x.ai/future', params: { value: 1 } } })
    })

    it('hides routine Grok startup diagnostics while keeping the terminal MCP failure concise', () => {
        const routine = normalizeDecryptedMessage(makeMessage({ role: 'agent', content: {
            type: 'codex', data: {
                type: 'grok-extension',
                method: '_x.ai/mcp/init_progress',
                params: { total: 2, connected: 1 }
            }
        } }))
        expect(routine).toBeNull()

        const retry = normalizeDecryptedMessage(makeMessage({ role: 'agent', content: {
            type: 'codex', data: {
                type: 'grok-extension',
                method: '_x.ai/mcp/server_status',
                params: {
                    name: 'telegram', status: 'unavailable', reason: 'restart_failed',
                    detail: 'attempt 2 of 3: handshake failed'
                }
            }
        } }))
        expect(retry).toBeNull()

        const exhausted = normalizeDecryptedMessage(makeMessage({ role: 'agent', content: {
            type: 'codex', data: {
                type: 'grok-extension',
                method: '_x.ai/mcp/server_status',
                params: {
                    name: 'telegram', status: 'unavailable', reason: 'restart_failed',
                    detail: 'exhausted after 3 attempts'
                }
            }
        } }))
        expect(exhausted).toMatchObject({
            role: 'agent',
            content: [{ type: 'text', text: 'Grok MCP telegram unavailable: exhausted after 3 attempts' }]
        })
    })

    it('hides Grok control-plane events that duplicate visible chat and tool activity', () => {
        const methods = [
            '_x.ai/sessions/changed',
            '_x.ai/queue/changed',
            '_x.ai/session/prompt_complete',
            '_x.ai/session_notification:tool_call_delta_chunk'
        ]

        for (const method of methods) {
            const message = normalizeDecryptedMessage(makeMessage({ role: 'agent', content: {
                type: 'codex',
                data: { type: 'grok-extension', method, params: { sessionId: 'grok-session-1' } }
            } }))
            expect(message, method).toBeNull()
        }
    })

    it('hides routine Grok lifecycle messages and the non-fatal grok-build summary diagnostic', () => {
        const messages = [
            'Grok session_summary_generated',
            'Grok interaction_pending',
            'Grok interaction_resolved',
            "ERROR responses API error status=403 Forbidden: The model 'grok-build' requires a Grok subscription. model_id=grok-build"
        ]

        for (const text of messages) {
            const message = normalizeDecryptedMessage(makeMessage({ role: 'agent', content: {
                type: 'event', data: { type: 'message', message: text }
            } }))
            expect(message, text).toBeNull()
        }
    })

    it('hides persisted Grok telemetry export failures from the session-event channel', () => {
        const telemetry = normalizeDecryptedMessage(makeMessage({ role: 'agent', content: {
            type: 'event', data: {
                type: 'message',
                message: 'ERROR name="BatchSpanProcessor.ExportError" error="HTTP export failed: network error"'
            }
        } }))
        expect(telemetry).toBeNull()
    })

    it('keeps assistant text and actionable session-event errors visible', () => {
        const assistantText = normalizeDecryptedMessage(makeMessage({ role: 'agent', content: {
            type: 'codex', data: {
                type: 'message',
                message: 'BatchSpanProcessor.ExportError means the HTTP export failed; here is how to fix it.'
            }
        } }))
        expect(assistantText).toMatchObject({
            role: 'agent',
            content: [{
                type: 'text',
                text: 'BatchSpanProcessor.ExportError means the HTTP export failed; here is how to fix it.'
            }]
        })

        const actionable = normalizeDecryptedMessage(makeMessage({ role: 'agent', content: {
            type: 'event', data: { type: 'message', message: 'responses API error status=402 Payment Required' }
        } }))
        expect(actionable).toMatchObject({
            role: 'event',
            content: { type: 'message', message: 'responses API error status=402 Payment Required' }
        })
    })

    it('drops codex agent attachments whose data-url MIME is not a valid MIME type', () => {
        const safe = {
            id: 'agent-att-safe',
            filename: 'report.csv',
            mimeType: 'text/csv',
            size: 8,
            path: 'hapi-agent-inline://agent-att-safe/report.csv',
            previewUrl: 'data:text/csv;base64,YSxiCjEsMgo='
        }
        const weirdMime = {
            id: 'agent-att-weird',
            filename: 'weird.bin',
            mimeType: '../../evil',
            size: 8,
            path: 'hapi-agent-inline://agent-att-weird/weird.bin',
            previewUrl: 'data:../../evil;base64,AAAA'
        }
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'attachments',
                    attachments: [weirdMime, safe]
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).not.toBeNull()
        if (normalized?.role !== 'agent') throw new Error('Expected agent')
        expect(normalized.content).toEqual([{
            type: 'attachments',
            attachments: [safe],
            uuid: message.id,
            parentUUID: null
        }])
    })

    it('normalizes Hermes MoA reference payloads as structured per-model blocks', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'moa-reference',
                    label: 'ref-model-a',
                    message: 'reference output',
                    index: 1,
                    count: 2
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).not.toBeNull()
        if (normalized?.role !== 'agent') throw new Error('Expected agent')
        expect(normalized.content).toEqual([{
            type: 'moa-reference',
            label: 'ref-model-a',
            text: 'reference output',
            index: 1,
            count: 2,
            uuid: message.id,
            parentUUID: null
        }])
    })

    it('normalizes Hermes MoA aggregation status as an event', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'moa-aggregating',
                    aggregator: 'agg-model'
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toMatchObject({
            id: 'msg-1',
            role: 'event',
            isSidechain: false,
            content: {
                type: 'moa-aggregating',
                aggregator: 'agg-model'
            }
        })
    })

})
