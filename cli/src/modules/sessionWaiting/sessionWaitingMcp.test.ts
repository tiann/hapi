import { describe, expect, it, vi } from 'vitest'
import type { Metadata } from '@hapi/protocol/types'
import { applySessionWaiting, handleSessionWaitingTool } from './sessionWaitingMcp'

describe('session_waiting MCP', () => {
    it('sets waiting with since + optional reason via updateMetadata', () => {
        const updates: Metadata[] = []
        const client = {
            updateMetadata(handler: (meta: Metadata) => Metadata) {
                updates.push(handler({ path: '/tmp/p', host: 'h' }))
            },
        }
        const before = Date.now()
        const result = applySessionWaiting(client, { action: 'set', reason: 'watch CI on tip' })
        expect(result.isError).toBe(false)
        expect(updates).toHaveLength(1)
        expect(updates[0]!.waiting).toMatchObject({ reason: 'watch CI on tip' })
        expect(updates[0]!.waiting!.since).toBeGreaterThanOrEqual(before)
        expect(updates[0]!.waiting!.since).toBeLessThanOrEqual(Date.now())
    })

    it('clears waiting with null', () => {
        const updates: Metadata[] = []
        const client = {
            updateMetadata(handler: (meta: Metadata) => Metadata) {
                updates.push(handler({
                    path: '/tmp/p',
                    host: 'h',
                    waiting: { since: 1, reason: 'old' },
                }))
            },
        }
        const result = applySessionWaiting(client, { action: 'clear' })
        expect(result.isError).toBe(false)
        expect(updates[0]).toMatchObject({ waiting: null })
    })

    it('surfaces updateMetadata failures as tool errors', async () => {
        const client = {
            updateMetadata: vi.fn(() => {
                throw new Error('socket down')
            }),
        }
        const result = await handleSessionWaitingTool({ action: 'set' }, client)
        expect(result.isError).toBe(true)
        expect(result.text).toContain('socket down')
    })
})
