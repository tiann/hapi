import { describe, expect, it, vi } from 'vitest'
import type { Metadata } from '@hapi/protocol/types'
import { applySessionWaiting, handleSessionWaitingTool } from './sessionWaitingMcp'

function makeClient(initial: Metadata) {
    let metadata: Metadata = { ...initial }
    return {
        get metadata() {
            return metadata
        },
        updateMetadata(handler: (meta: Metadata) => Metadata) {
            metadata = handler(metadata)
        },
        flushMetadata: vi.fn(async () => true),
        getMetadata: () => metadata,
    }
}

describe('session_waiting MCP', () => {
    it('sets waiting with since + optional reason after hub flush', async () => {
        const client = makeClient({ path: '/tmp/p', host: 'h' })
        const before = Date.now()
        const result = await applySessionWaiting(client, { action: 'set', reason: 'watch CI on tip' })
        expect(result.isError).toBe(false)
        expect(client.flushMetadata).toHaveBeenCalledTimes(1)
        expect(client.metadata.waiting).toMatchObject({ reason: 'watch CI on tip' })
        expect(client.metadata.waiting!.since).toBeGreaterThanOrEqual(before)
        expect(client.metadata.waiting!.since).toBeLessThanOrEqual(Date.now())
        expect(result.text).toContain('reason="watch CI on tip"')
    })

    it('clears waiting with null after hub flush', async () => {
        const client = makeClient({
            path: '/tmp/p',
            host: 'h',
            waiting: { since: 1, reason: 'old' },
        })
        const result = await applySessionWaiting(client, { action: 'clear' })
        expect(result.isError).toBe(false)
        expect(client.flushMetadata).toHaveBeenCalledTimes(1)
        expect(client.metadata).toMatchObject({ waiting: null })
    })

    it('returns unconfirmed error when flushMetadata times out', async () => {
        const client = makeClient({ path: '/tmp/p', host: 'h' })
        client.flushMetadata.mockResolvedValue(false)
        const result = await applySessionWaiting(client, { action: 'set', reason: 'CI' })
        expect(result.isError).toBe(true)
        expect(result.text).toContain('unconfirmed')
        expect(result.text).toContain('timed out')
    })

    it('returns unconfirmed error when clear flush succeeds but waiting remains', async () => {
        const client = {
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            getMetadata: () => ({
                path: '/tmp/p',
                host: 'h',
                waiting: { since: 99, reason: 'stuck' },
            }) as Metadata,
        }
        const result = await applySessionWaiting(client, { action: 'clear' })
        expect(result.isError).toBe(true)
        expect(result.text).toContain('still has metadata.waiting')
    })

    it('surfaces updateMetadata failures as tool errors', async () => {
        const client = {
            updateMetadata: vi.fn(() => {
                throw new Error('socket down')
            }),
            flushMetadata: vi.fn(async () => true),
            getMetadata: () => null,
        }
        const result = await handleSessionWaitingTool({ action: 'set' }, client)
        expect(result.isError).toBe(true)
        expect(result.text).toContain('socket down')
        expect(client.flushMetadata).not.toHaveBeenCalled()
    })
})
