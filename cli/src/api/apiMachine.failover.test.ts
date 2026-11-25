import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ioMock = vi.hoisted(() => vi.fn())
const listOpencodeModelsForCwdMock = vi.hoisted(() => vi.fn())
const listOpencodeModelVariantsMock = vi.hoisted(() => vi.fn())
const listGrokModelsForCwdMock = vi.hoisted(() => vi.fn())
const listCopilotModelsForCwdMock = vi.hoisted(() => vi.fn())
const listKimiModelsForCwdMock = vi.hoisted(() => vi.fn())
const inspectCursorChatStoreMock = vi.hoisted(() => vi.fn())

vi.mock('socket.io-client', () => ({
    io: ioMock
}))

vi.mock('../modules/common/opencodeModels', () => ({
    listOpencodeModelsForCwd: listOpencodeModelsForCwdMock
}))

vi.mock('../modules/common/opencodeModelVariants', () => ({
    listOpencodeModelVariants: listOpencodeModelVariantsMock
}))

vi.mock('../modules/common/grokModels', () => ({
    listGrokModelsForCwd: listGrokModelsForCwdMock
}))

vi.mock('../modules/common/copilotModels', () => ({
    listCopilotModelsForCwd: listCopilotModelsForCwdMock
}))

vi.mock('../modules/common/kimiModels', () => ({
    listKimiModelsForCwd: listKimiModelsForCwdMock
}))

vi.mock('@/cursor/cursorChatStoreStatus', () => ({
    inspectCursorChatStore: inspectCursorChatStoreMock
}))

import {
    ApiMachineClient,
    DEFAULT_FAILOVER_AFTER,
    PRIMARY_ENTRY_RETRY_DELAY_MS,
    buildHubEntryRotation,
    resolveFailoverThreshold
} from './apiMachine'
import { configuration } from '@/configuration'
import { logger } from '@/ui/logger'
import type { Machine } from './types'

function makeMachine(id: string): Machine {
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: null,
        metadataVersion: 0,
        runnerState: null,
        runnerStateVersion: 0
    }
}

describe('buildHubEntryRotation', () => {
    it('returns only the primary entry when the fallback env is unset', () => {
        expect(buildHubEntryRotation('https://primary.example', undefined))
            .toEqual(['https://primary.example'])
    })

    it('returns only the primary entry when every fallback entry is blank', () => {
        expect(buildHubEntryRotation('https://primary.example', ' , ,, '))
            .toEqual(['https://primary.example'])
    })

    it('appends trimmed fallback entries after the primary', () => {
        expect(buildHubEntryRotation('https://primary.example', ' https://a.example ,https://b.example '))
            .toEqual(['https://primary.example', 'https://a.example', 'https://b.example'])
    })

    it('strips trailing slashes from fallback entries but keeps the primary verbatim', () => {
        expect(buildHubEntryRotation('https://primary.example/', 'https://a.example/,,https://b.example///'))
            .toEqual(['https://primary.example/', 'https://a.example', 'https://b.example'])
    })

    it('drops duplicates against the primary and within the fallback list', () => {
        expect(buildHubEntryRotation('https://primary.example', 'https://primary.example,https://a.example,https://a.example/'))
            .toEqual(['https://primary.example', 'https://a.example'])
    })
})

describe('resolveFailoverThreshold', () => {
    it(`defaults to ${DEFAULT_FAILOVER_AFTER} for unset, blank, non-numeric or non-positive values`, () => {
        expect(resolveFailoverThreshold(undefined)).toBe(DEFAULT_FAILOVER_AFTER)
        expect(resolveFailoverThreshold('')).toBe(DEFAULT_FAILOVER_AFTER)
        expect(resolveFailoverThreshold('   ')).toBe(DEFAULT_FAILOVER_AFTER)
        expect(resolveFailoverThreshold('not-a-number')).toBe(DEFAULT_FAILOVER_AFTER)
        expect(resolveFailoverThreshold('0')).toBe(DEFAULT_FAILOVER_AFTER)
        expect(resolveFailoverThreshold('-3')).toBe(DEFAULT_FAILOVER_AFTER)
    })

    it('accepts positive integers and trims whitespace', () => {
        expect(resolveFailoverThreshold('3')).toBe(3)
        expect(resolveFailoverThreshold(' 12 ')).toBe(12)
    })
})

type FakeSocket = {
    on: ReturnType<typeof vi.fn>
    emit: ReturnType<typeof vi.fn>
    emitWithAck: ReturnType<typeof vi.fn>
    removeAllListeners: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
}

type CreatedSocket = {
    url: string
    options: Record<string, unknown>
    socket: FakeSocket
    fire: (event: string, ...args: unknown[]) => void
}

/**
 * Creates a minimal socket.io double that records `on` handlers so tests can
 * fire connect/connect_error like the real client would, and tracks every
 * socket the client creates (URL + options) via the io mock.
 */
function trackSockets(): CreatedSocket[] {
    const created: CreatedSocket[] = []
    ioMock.mockImplementation((url: string, options: Record<string, unknown>) => {
        const handlers = new Map<string, (...args: unknown[]) => void>()
        const socket = {
            on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                handlers.set(event, handler)
            }),
            emit: vi.fn(),
            // Valid success ack for machine-update-state so the connect
            // handler's backoff-wrapped RPC settles immediately.
            emitWithAck: vi.fn().mockResolvedValue({
                result: 'success',
                version: 1,
                runnerState: { status: 'running', capabilities: {} }
            }),
            removeAllListeners: vi.fn(),
            close: vi.fn()
        }
        const fire = (event: string, ...args: unknown[]) => {
            const handler = handlers.get(event)
            if (!handler) throw new Error(`No fake-socket handler registered for "${event}"`)
            handler(...args)
        }
        created.push({ url, options, socket, fire })
        return socket
    })
    return created
}

function fireConnectError(entry: CreatedSocket, message = 'websocket error'): void {
    entry.fire('connect_error', new Error(message))
}

function primaryRetryTimerOf(client: ApiMachineClient): unknown {
    return (client as unknown as { primaryEntryRetryTimer: unknown }).primaryEntryRetryTimer
}

describe('ApiMachineClient hub entry failover', () => {
    const originalFallbackEnv = process.env.HAPI_API_FALLBACK_URLS
    const originalFailoverAfterEnv = process.env.HAPI_API_FAILOVER_AFTER
    let debugSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        vi.useFakeTimers()
        ioMock.mockReset()
        // Silence debug logging while keeping calls observable for assertions.
        debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})
        delete process.env.HAPI_API_FALLBACK_URLS
        delete process.env.HAPI_API_FAILOVER_AFTER
    })

    afterEach(() => {
        vi.clearAllTimers()
        vi.useRealTimers()
        vi.restoreAllMocks()
        if (originalFallbackEnv === undefined) delete process.env.HAPI_API_FALLBACK_URLS
        else process.env.HAPI_API_FALLBACK_URLS = originalFallbackEnv
        if (originalFailoverAfterEnv === undefined) delete process.env.HAPI_API_FAILOVER_AFTER
        else process.env.HAPI_API_FAILOVER_AFTER = originalFailoverAfterEnv
    })

    it('never rotates when no fallback entries are configured', () => {
        const created = trackSockets()
        const machine = makeMachine('failover-none')
        const client = new ApiMachineClient('cli-token', machine)

        try {
            client.connect()
            for (let i = 0; i < 12; i++) {
                fireConnectError(created[0])
            }

            expect(ioMock).toHaveBeenCalledTimes(1)
            expect(created[0].url).toBe(`${configuration.apiUrl}/cli`)
            expect(created[0].socket.close).not.toHaveBeenCalled()
            expect(created[0].socket.removeAllListeners).not.toHaveBeenCalled()
        } finally {
            client.shutdown()
        }
    })

    it('treats an all-blank fallback env exactly like unset (zero rotation)', () => {
        process.env.HAPI_API_FALLBACK_URLS = '  , , '
        const created = trackSockets()
        const client = new ApiMachineClient('cli-token', makeMachine('failover-blank'))

        try {
            client.connect()
            for (let i = 0; i < 8; i++) {
                fireConnectError(created[0])
            }
            expect(ioMock).toHaveBeenCalledTimes(1)
        } finally {
            client.shutdown()
        }
    })

    it('rebuilds the socket on the fallback origin after the 5th consecutive connect failure', () => {
        process.env.HAPI_API_FALLBACK_URLS = 'https://fallback-a.example,https://fallback-b.example'
        const created = trackSockets()
        const machine = makeMachine('failover-rotate')
        const client = new ApiMachineClient('cli-token', machine)

        try {
            client.connect()
            for (let i = 0; i < 4; i++) {
                fireConnectError(created[0])
            }
            expect(ioMock).toHaveBeenCalledTimes(1)

            fireConnectError(created[0]) // 5th consecutive failure
            expect(ioMock).toHaveBeenCalledTimes(2)
            expect(created[0].url).toBe(`${configuration.apiUrl}/cli`)
            expect(created[1].url).toBe('https://fallback-a.example/cli')
            // Old socket is torn down so its own reconnection loop cannot interfere.
            expect(created[0].socket.removeAllListeners).toHaveBeenCalled()
            expect(created[0].socket.close).toHaveBeenCalled()
            // Rotation log line in the file's established style.
            expect(debugSpy).toHaveBeenCalledWith(
                `[API MACHINE] rotating hub entry ${configuration.apiUrl} -> https://fallback-a.example after 5 connect failures`
            )
            // The rebuilt socket carries identical origin-independent options.
            expect(created[1].options).toMatchObject({
                path: '/socket.io/',
                auth: {
                    token: 'cli-token',
                    clientType: 'machine-scoped',
                    machineId: machine.id
                }
            })
        } finally {
            client.shutdown()
        }
    })

    it('rotates around the ring and eventually wraps back to the primary entry', () => {
        process.env.HAPI_API_FALLBACK_URLS = 'https://fallback-a.example,https://fallback-b.example'
        const created = trackSockets()
        const client = new ApiMachineClient('cli-token', makeMachine('failover-ring'))

        try {
            client.connect()
            for (let i = 0; i < 5; i++) fireConnectError(created[0])
            expect(created[1].url).toBe('https://fallback-a.example/cli')

            for (let i = 0; i < 5; i++) fireConnectError(created[1])
            expect(created[2].url).toBe('https://fallback-b.example/cli')

            for (let i = 0; i < 5; i++) fireConnectError(created[2])
            expect(created[3].url).toBe(`${configuration.apiUrl}/cli`)
            expect(ioMock).toHaveBeenCalledTimes(4)
        } finally {
            client.shutdown()
        }
    })

    it('honors HAPI_API_FAILOVER_AFTER when set', () => {
        process.env.HAPI_API_FALLBACK_URLS = 'https://fallback-a.example'
        process.env.HAPI_API_FAILOVER_AFTER = '2'
        const created = trackSockets()
        const client = new ApiMachineClient('cli-token', makeMachine('failover-threshold'))

        try {
            client.connect()
            fireConnectError(created[0])
            expect(ioMock).toHaveBeenCalledTimes(1)
            fireConnectError(created[0])
            expect(ioMock).toHaveBeenCalledTimes(2)
            expect(created[1].url).toBe('https://fallback-a.example/cli')
        } finally {
            client.shutdown()
        }
    })

    it('resets the failure streak after a successful connect', () => {
        process.env.HAPI_API_FALLBACK_URLS = 'https://fallback-a.example'
        const created = trackSockets()
        const client = new ApiMachineClient('cli-token', makeMachine('failover-reset'))

        try {
            client.connect()
            for (let i = 0; i < 3; i++) {
                fireConnectError(created[0])
            }

            // A completed handshake on the current entry clears the streak.
            created[0].fire('connect')

            for (let i = 0; i < 4; i++) {
                fireConnectError(created[0])
            }
            expect(ioMock).toHaveBeenCalledTimes(1)

            // The 5th failure after the reset triggers the rotation.
            fireConnectError(created[0])
            expect(ioMock).toHaveBeenCalledTimes(2)
            expect(created[1].url).toBe('https://fallback-a.example/cli')
        } finally {
            client.shutdown()
        }
    })

    it('arms the primary retry timer after connecting on a fallback and returns to the primary when it fires', () => {
        process.env.HAPI_API_FALLBACK_URLS = 'https://fallback-a.example'
        const created = trackSockets()
        const client = new ApiMachineClient('cli-token', makeMachine('failover-primary-retry'))

        try {
            client.connect()
            for (let i = 0; i < 5; i++) fireConnectError(created[0])
            expect(created[1].url).toBe('https://fallback-a.example/cli')

            // No timer while never connected on the fallback.
            expect(primaryRetryTimerOf(client)).toBeNull()

            created[1].fire('connect')
            expect(primaryRetryTimerOf(client)).not.toBeNull()

            // One ms before the dwell elapses: still on the fallback.
            vi.advanceTimersByTime(PRIMARY_ENTRY_RETRY_DELAY_MS - 1)
            expect(ioMock).toHaveBeenCalledTimes(2)

            vi.advanceTimersByTime(1)
            expect(ioMock).toHaveBeenCalledTimes(3)
            expect(created[2].url).toBe(`${configuration.apiUrl}/cli`)
            expect(created[1].socket.close).toHaveBeenCalled()
            expect(primaryRetryTimerOf(client)).toBeNull()

            // Dwelling on the primary never re-arms a retry timer.
            created[2].fire('connect')
            expect(primaryRetryTimerOf(client)).toBeNull()
            vi.advanceTimersByTime(PRIMARY_ENTRY_RETRY_DELAY_MS * 2)
            expect(ioMock).toHaveBeenCalledTimes(3)
        } finally {
            client.shutdown()
        }
    })

    it('clears the pending primary retry timer when the connection rotates again, then re-arms on the new fallback', () => {
        process.env.HAPI_API_FALLBACK_URLS = 'https://fallback-a.example,https://fallback-b.example'
        const created = trackSockets()
        const client = new ApiMachineClient('cli-token', makeMachine('failover-timer-cleanup'))

        try {
            client.connect()
            for (let i = 0; i < 5; i++) fireConnectError(created[0])
            created[1].fire('connect') // connected on fallback-a, timer armed
            expect(primaryRetryTimerOf(client)).not.toBeNull()

            vi.advanceTimersByTime(10 * 60 * 1000)

            // Fallback-a dies too: rotation must clear its pending timer first.
            for (let i = 0; i < 5; i++) fireConnectError(created[1])
            expect(created[2].url).toBe('https://fallback-b.example/cli')
            expect(primaryRetryTimerOf(client)).toBeNull()

            // Nothing fires from the stale timer.
            vi.advanceTimersByTime(PRIMARY_ENTRY_RETRY_DELAY_MS)
            expect(ioMock).toHaveBeenCalledTimes(3)

            // Connecting on fallback-b arms a fresh 30min timer.
            created[2].fire('connect')
            expect(primaryRetryTimerOf(client)).not.toBeNull()
            vi.advanceTimersByTime(PRIMARY_ENTRY_RETRY_DELAY_MS)
            expect(ioMock).toHaveBeenCalledTimes(4)
            expect(created[3].url).toBe(`${configuration.apiUrl}/cli`)
        } finally {
            client.shutdown()
        }
    })

    it('clears the pending primary retry timer on shutdown', () => {
        process.env.HAPI_API_FALLBACK_URLS = 'https://fallback-a.example'
        const created = trackSockets()
        const client = new ApiMachineClient('cli-token', makeMachine('failover-shutdown'))

        try {
            client.connect()
            for (let i = 0; i < 5; i++) fireConnectError(created[0])
            created[1].fire('connect')
            expect(primaryRetryTimerOf(client)).not.toBeNull()

            client.shutdown()
            expect(primaryRetryTimerOf(client)).toBeNull()

            vi.advanceTimersByTime(PRIMARY_ENTRY_RETRY_DELAY_MS * 2)
            expect(ioMock).toHaveBeenCalledTimes(2)
        } finally {
            client.shutdown()
        }
    })
})
