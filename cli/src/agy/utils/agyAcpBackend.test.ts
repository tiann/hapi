import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@/agent/types'

const constructorCalls: Array<Record<string, unknown>> = []

vi.mock('@/agent/backends/acp', async () => {
    const actual = await vi.importActual<typeof import('@/agent/backends/acp')>('@/agent/backends/acp')
    return {
        ...actual,
        AcpSdkBackend: vi.fn().mockImplementation(function (
            this: unknown,
            opts: Record<string, unknown>
        ) {
            constructorCalls.push(opts)
            return { __opts: opts }
        })
    }
})

import { AcpMessageHandler, type AcpTextChunkMode } from '@/agent/backends/acp'
import { createAgyAcpBackend } from './agyAcpBackend'

// agy streams agent_message_chunk as pure deltas (verified against agy 1.5.3),
// so the repeated digit at the chunk boundary must not be read as an overlap.
function assemble(chunks: string[], textChunkMode: AcpTextChunkMode | undefined): string {
    const messages: AgentMessage[] = []
    const handler = new AcpMessageHandler((message) => messages.push(message), { textChunkMode })
    for (const text of chunks) {
        handler.handleUpdate({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
        })
    }
    handler.flushText()
    return messages.map((message) => (message.type === 'text' ? message.text : '')).join('')
}

function configuredMode(): AcpTextChunkMode | undefined {
    constructorCalls.length = 0
    createAgyAcpBackend()
    expect(constructorCalls).toHaveLength(1)
    return constructorCalls[0]?.textChunkMode as AcpTextChunkMode | undefined
}

describe('createAgyAcpBackend text chunk assembly', () => {
    beforeEach(() => {
        constructorCalls.length = 0
    })

    it('keeps the repeated 8 when a number is split across chunks', () => {
        expect(assemble(['Call 73-8', '800 now'], configuredMode())).toBe('Call 73-8800 now')
    })

    it('keeps repeated characters at chunk boundaries (agy 1.5.3 capture)', () => {
        expect(assemble(
            ['73-8800 880', '0 5566 qq rr 3322 ee'],
            configuredMode()
        )).toBe('73-8800 8800 5566 qq rr 3322 ee')
        expect(assemble(
            ['8800 9999 33322', '2 ababab', ' ab', 'ab'],
            configuredMode()
        )).toBe('8800 9999 333222 ababab abab')
    })

    it('sets the delta text chunk mode explicitly', () => {
        expect(configuredMode()).toBe('delta')
    })
})
