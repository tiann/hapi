import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TELEMETRY_KINDS } from '@hapi/protocol/telemetry'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import {
    clearMessageWindow,
    collectWindowInventory,
    getMessageWindowState,
    recoverWindowAfterGapResume,
    subscribeMessageWindow,
    syncTailMessages,
} from '@/lib/message-window-store'

vi.mock('@/lib/telemetryClient', () => ({
    telemetryClient: { capture: vi.fn(), setTrigger: vi.fn() },
    bindTelemetryClient: vi.fn(),
}))

import { telemetryClient } from '@/lib/telemetryClient'

const captureMock = vi.mocked(telemetryClient.capture)

const touched = new Set<string>()
function sessionId(name: string): string {
    const id = `telemetry-store-${name}`
    touched.add(id)
    return id
}

// Same envelope shape the store's own fixtures use (proven to be retained
// by the merge path): a live reasoning row from the codex payload family.
function agentMessage(id: string, seq: number, at: number): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        content: {
            role: 'agent',
            content: { type: 'codex', data: { type: 'reasoning', message: id, id: `stream-${id}` } }
        },
        createdAt: at,
        invokedAt: at
    } as DecryptedMessage
}

function latestResponse(messages: DecryptedMessage[], epoch = 1): MessagesResponse {
    return {
        messages,
        page: {
            direction: 'latest',
            limit: 200,
            epoch,
            reset: false,
            nextBeforeAt: null,
            nextBeforeSeq: null,
            nextAfterAt: null,
            nextAfterSeq: null,
            snapshotHeadAt: null,
            snapshotHeadSeq: null,
            hasMore: false
        }
    }
}

function afterResponse(messages: DecryptedMessage[], epoch = 1): MessagesResponse {
    return {
        messages,
        page: {
            direction: 'after',
            limit: 200,
            epoch,
            reset: false,
            nextBeforeAt: null,
            nextBeforeSeq: null,
            nextAfterAt: 1_000,
            nextAfterSeq: 10,
            snapshotHeadAt: 1_000,
            snapshotHeadSeq: 10,
            hasMore: false
        }
    }
}

function createApi(getMessages: ApiClient['getMessages']): ApiClient {
    return { getMessages, getMessageContext: async () => null } as unknown as ApiClient
}

function incompleteEvents(signal: string): Array<Record<string, unknown>> {
    return captureMock.mock.calls
        .filter((call) => call[1] === 'load_incomplete' && (call[2] as { signal?: string }).signal === signal)
        .map((call) => call[2])
}

function expectSchemaValid(kind: string, data: unknown): void {
    const spec = TELEMETRY_KINDS[kind]
    expect(spec, `kind ${kind} must be registered`).toBeDefined()
    const parsed = spec!.data.safeParse(data)
    if (!parsed.success) {
        throw new Error(`schema violation for ${kind}: ${JSON.stringify(parsed.error.issues)}`)
    }
}

beforeEach(() => {
    captureMock.mockClear()
    localStorage.clear()
    sessionStorage.clear()
})

afterEach(() => {
    for (const id of touched) {
        clearMessageWindow(id)
    }
    touched.clear()
    localStorage.clear()
    sessionStorage.clear()
    vi.useRealTimers()
})

describe('load_incomplete signals', () => {
    it('tail-warning fires on null→non-null warning and passes the sanitize net', async () => {
        const id = sessionId('tail-warning')
        const api = createApi(async () => {
            throw new Error('Fetch failed: 502 Bearer sk-supersecretabcdef012345 body {"token=abc123"}')
        })

        await syncTailMessages(api, id)

        const events = incompleteEvents('tail-warning')
        expect(events).toHaveLength(1)
        expect(events[0]).toEqual({
            signal: 'tail-warning',
            // the Bearer net consumes the sk- token whole (its charset
            // includes the sk- prefix), then token= is redacted
            warningText: 'Fetch failed: 502 Bearer [redacted] body {"token=[redacted]"}'
        })
        expectSchemaValid('load_incomplete', events[0])
        expect(getMessageWindowState(id).warning).toBeTruthy()
    })

    it('a successful settle over an empty window reports empty-window', async () => {
        const id = sessionId('empty-window')
        const api = createApi(async () => latestResponse([], 1))

        await syncTailMessages(api, id)

        const events = incompleteEvents('empty-window')
        expect(events).toHaveLength(1)
        expect(events[0]).toEqual({ signal: 'empty-window' })
        expectSchemaValid('load_incomplete', events[0])
    })

    it('a successful non-empty settle reports nothing', async () => {
        const id = sessionId('healthy')
        const api = createApi(async () => latestResponse([agentMessage('m1', 1, 1_000)], 1))

        await syncTailMessages(api, id)

        expect(captureMock.mock.calls.filter((call) => call[1] === 'load_incomplete')).toHaveLength(0)
    })

    it('gap-recovery fires when a gap resume arms the reconciliation', async () => {
        const id = sessionId('gap-recovery')
        let latest = agentMessage('call-row', 10, 1_000)
        const api = createApi(async (_sessionId, query) => {
            if (query.afterAt !== undefined) {
                return afterResponse([], 1)
            }
            return latestResponse([latest], 1)
        })

        await syncTailMessages(api, id)
        expect(incompleteEvents('gap-recovery')).toHaveLength(0)

        latest = agentMessage('call-row', 10, 2_000)
        await recoverWindowAfterGapResume(api, id)

        const events = incompleteEvents('gap-recovery')
        expect(events).toHaveLength(1)
        expect(events[0]).toEqual({ signal: 'gap-recovery' })
        expectSchemaValid('load_incomplete', events[0])
    })
})

describe('collectWindowInventory', () => {
    it('reports held windows, persistence, activity and storage bytes (raw.length metric)', async () => {
        const persistedId = sessionId('persisted')
        const memoryOnlyId = sessionId('memory-only')
        const api = createApi(async (target, query) => {
            if (query.afterAt !== undefined) {
                return afterResponse([], 1)
            }
            return latestResponse([agentMessage(`${target}-m1`, 1, 1_000)], 1)
        })

        await syncTailMessages(api, persistedId)
        // Let the store's 200ms persist debounce flush (real timers; the
        // write itself is what makes the window observable as persisted).
        await new Promise((resolve) => setTimeout(resolve, 260))
        await syncTailMessages(api, memoryOnlyId)
        // memoryOnlyId never persists: strip its storage behind the store's back
        localStorage.removeItem(`hapi:message-window:v3:${memoryOnlyId}`)

        const unsubscribe = subscribeMessageWindow(persistedId, () => {})
        try {
            const inventory = collectWindowInventory()
            expect(inventory.sessionsHeld).toBeGreaterThanOrEqual(2)

            const persistedWindow = inventory.windows.find((w) => w.persisted)
            expect(persistedWindow).toBeDefined()
            expect(persistedWindow!.messageCount).toBeGreaterThan(0)
            expect(persistedWindow!.approxBytes).toBeGreaterThan(0)
            // the subscribed session is the active one
            expect(inventory.windows.some((w) => w.active)).toBe(true)

            const memoryOnly = inventory.windows.find((w) => !w.persisted)
            if (memoryOnly) {
                expect(memoryOnly.approxBytes).toBeGreaterThan(0)
            }

            expect(inventory.storageUsedBytes).toBeGreaterThan(0)
            expectSchemaValid('client_window_inventory', inventory)
        } finally {
            unsubscribe()
        }
    })

    it('caps windows at the schema limit of 128', () => {
        const unsubscribes: Array<() => void> = []
        try {
            for (let i = 0; i < 130; i += 1) {
                const id = sessionId(`cap-${i}`)
                // subscribe before materializing: a listener protects the
                // window from inactive-eviction the moment it is created
                unsubscribes.push(subscribeMessageWindow(id, () => {}))
                getMessageWindowState(id)
            }
            const inventory = collectWindowInventory()
            expect(inventory.sessionsHeld).toBeGreaterThanOrEqual(130)
            expect(inventory.windows.length).toBeLessThanOrEqual(128)
            expectSchemaValid('client_window_inventory', {
                sessionsHeld: inventory.sessionsHeld,
                storageUsedBytes: inventory.storageUsedBytes,
                windows: inventory.windows
            })
        } finally {
            for (const unsubscribe of unsubscribes) {
                unsubscribe()
            }
        }
    })
})
