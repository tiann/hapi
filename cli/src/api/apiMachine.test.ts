import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const ioMock = vi.hoisted(() => vi.fn())
const listOpencodeModelsForCwdMock = vi.hoisted(() => vi.fn())
const listGrokModelsForCwdMock = vi.hoisted(() => vi.fn())
const inspectCursorChatStoreMock = vi.hoisted(() => vi.fn())

vi.mock('socket.io-client', () => ({
    io: ioMock
}))

vi.mock('@/api/auth', () => ({
    getAuthToken: () => 'cli-token'
}))

vi.mock('../modules/common/opencodeModels', () => ({
    listOpencodeModelsForCwd: listOpencodeModelsForCwdMock
}))

vi.mock('../modules/common/grokModels', () => ({
    listGrokModelsForCwd: listGrokModelsForCwdMock
}))

vi.mock('@/cursor/cursorChatStoreStatus', () => ({
    inspectCursorChatStore: inspectCursorChatStoreMock
}))

import { ApiMachineClient, normalizeWindowsDriveRoot } from './apiMachine'
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

describe('normalizeWindowsDriveRoot', () => {
    it('restores the trailing separator when Windows realpath returns a bare drive', () => {
        expect(normalizeWindowsDriveRoot('C:')).toBe('C:\\')
        expect(normalizeWindowsDriveRoot('D:')).toBe('D:\\')
    })

    it('leaves non-drive-root paths unchanged', () => {
        expect(normalizeWindowsDriveRoot('C:\\Users')).toBe('C:\\Users')
        expect(normalizeWindowsDriveRoot('/tmp/workspace')).toBe('/tmp/workspace')
    })
})

async function callListOpencodeModels(client: ApiMachineClient, machineId: string, cwd: string): Promise<unknown> {
    // Reach into the private rpc handler manager to dispatch a request.
    // Mirrors how the on-socket 'rpc-request' listener invokes handleRequest.
    const manager = (client as unknown as { rpcHandlerManager: { handleRequest: (req: { method: string; params: string }) => Promise<string> } }).rpcHandlerManager
    const raw = await manager.handleRequest({
        method: `${machineId}:listOpencodeModelsForCwd`,
        params: JSON.stringify({ cwd })
    })
    return JSON.parse(raw) as unknown
}

async function callListGrokModels(client: ApiMachineClient, machineId: string, cwd: string): Promise<unknown> {
    const manager = (client as unknown as { rpcHandlerManager: { handleRequest: (req: { method: string; params: string }) => Promise<string> } }).rpcHandlerManager
    const raw = await manager.handleRequest({
        method: `${machineId}:listGrokModelsForCwd`,
        params: JSON.stringify({ cwd })
    })
    return JSON.parse(raw) as unknown
}

async function callCursorChatStoreStatus(
    client: ApiMachineClient,
    machineId: string,
    params: { workspacePath: string; cursorSessionId: string; homeDir?: string }
): Promise<unknown> {
    const manager = (client as unknown as { rpcHandlerManager: { handleRequest: (req: { method: string; params: string }) => Promise<string> } }).rpcHandlerManager
    const raw = await manager.handleRequest({
        method: `${machineId}:cursor-chat-store-status`,
        params: JSON.stringify(params)
    })
    return JSON.parse(raw) as unknown
}

async function callListCodexSessions(client: ApiMachineClient, machineId: string, params: { cwd?: string | null; sessionIds?: string[] }): Promise<unknown> {
    const manager = (client as unknown as { rpcHandlerManager: { handleRequest: (req: { method: string; params: string }) => Promise<string> } }).rpcHandlerManager
    const raw = await manager.handleRequest({
        method: `${machineId}:listCodexSessions`,
        params: JSON.stringify(params)
    })
    return JSON.parse(raw) as unknown
}

async function callArchiveCodexSession(client: ApiMachineClient, machineId: string, sessionId: string): Promise<unknown> {
    const manager = (client as unknown as { rpcHandlerManager: { handleRequest: (req: { method: string; params: string }) => Promise<string> } }).rpcHandlerManager
    const raw = await manager.handleRequest({
        method: `${machineId}:archiveCodexSession`,
        params: JSON.stringify({ sessionId })
    })
    return JSON.parse(raw) as unknown
}

function writeCodexTranscript(codexHome: string, fileName: string, payload: Record<string, unknown>, userText: string): string {
    const sessionDir = join(codexHome, 'sessions', '2026', '06', '29')
    mkdirSync(sessionDir, { recursive: true })
    const file = join(sessionDir, fileName)
    writeFileSync(file, [
        JSON.stringify({ type: 'session_meta', payload }),
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: userText }] } })
    ].join('\n'))
    return file
}

describe('ApiMachineClient cursor-chat-store-status handler', () => {
    beforeEach(() => {
        inspectCursorChatStoreMock.mockReset()
        inspectCursorChatStoreMock.mockResolvedValue({ onDisk: false, store: null })
    })

    it('inspects stores under the recorded session owner home', async () => {
        const machine = makeMachine('cursor-store-machine')
        const client = new ApiMachineClient('cli-token', machine)

        try {
            await callCursorChatStoreStatus(client, machine.id, {
                workspacePath: '/work/project',
                cursorSessionId: 'cursor-session',
                homeDir: '  /home/recorded-owner  '
            })

            expect(inspectCursorChatStoreMock).toHaveBeenCalledWith({
                home: '/home/recorded-owner',
                workspacePath: '/work/project',
                cursorSessionId: 'cursor-session'
            })
        } finally {
            client.shutdown()
        }
    })

    it('falls back to the CLI process home for old or whitespace-only homeDir metadata', async () => {
        const machine = makeMachine('cursor-store-fallback-machine')
        const client = new ApiMachineClient('cli-token', machine)

        try {
            await callCursorChatStoreStatus(client, machine.id, {
                workspacePath: '/work/project',
                cursorSessionId: 'cursor-session-old'
            })
            await callCursorChatStoreStatus(client, machine.id, {
                workspacePath: '/work/project',
                cursorSessionId: 'cursor-session-empty',
                homeDir: '   '
            })

            expect(inspectCursorChatStoreMock).toHaveBeenNthCalledWith(1, {
                home: homedir(),
                workspacePath: '/work/project',
                cursorSessionId: 'cursor-session-old'
            })
            expect(inspectCursorChatStoreMock).toHaveBeenNthCalledWith(2, {
                home: homedir(),
                workspacePath: '/work/project',
                cursorSessionId: 'cursor-session-empty'
            })
        } finally {
            client.shutdown()
        }
    })
})

describe('ApiMachineClient listOpencodeModelsForCwd handler', () => {
    let workspaceRoot: string

    beforeEach(() => {
        ioMock.mockReset()
        listOpencodeModelsForCwdMock.mockReset()
        listGrokModelsForCwdMock.mockReset()
        workspaceRoot = mkdtempSync(join(tmpdir(), 'hapi-machine-ws-'))
    })

    afterEach(() => {
        rmSync(workspaceRoot, { recursive: true, force: true })
    })

    it('rejects cwd outside the workspace root with the standard error shape', async () => {
        const machine = makeMachine('machine-1')
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])

        const outsideCwd = mkdtempSync(join(tmpdir(), 'hapi-outside-'))
        try {
            const result = await callListOpencodeModels(client, machine.id, outsideCwd)
            expect(result).toEqual({ success: false, error: 'Path is outside workspace roots' })
            expect(listOpencodeModelsForCwdMock).not.toHaveBeenCalled()
        } finally {
            rmSync(outsideCwd, { recursive: true, force: true })
            client.shutdown()
        }
    })

    it('rejects empty cwd with cwd-required error', async () => {
        const machine = makeMachine('machine-2')
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])

        try {
            const result = await callListOpencodeModels(client, machine.id, '')
            expect(result).toEqual({ success: false, error: 'cwd is required' })
            expect(listOpencodeModelsForCwdMock).not.toHaveBeenCalled()
        } finally {
            client.shutdown()
        }
    })

    it('forwards a workspace-internal cwd to listOpencodeModelsForCwd', async () => {
        const machine = makeMachine('machine-3')
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])

        const innerDir = join(workspaceRoot, 'inner-project')
        mkdirSync(innerDir)

        listOpencodeModelsForCwdMock.mockResolvedValueOnce({
            success: true,
            availableModels: [{ modelId: 'a/b' }],
            currentModelId: 'a/b'
        })

        try {
            const result = await callListOpencodeModels(client, machine.id, innerDir)
            expect(result).toEqual({
                success: true,
                availableModels: [{ modelId: 'a/b' }],
                currentModelId: 'a/b'
            })
            expect(listOpencodeModelsForCwdMock).toHaveBeenCalledTimes(1)
            // The handler should pass the resolved (realpath'd) cwd to the lower layer.
            expect(listOpencodeModelsForCwdMock).toHaveBeenCalledWith(expect.stringContaining('inner-project'))
        } finally {
            client.shutdown()
        }
    })

    it('accepts cwd inside any configured workspace root', async () => {
        const machine = makeMachine('machine-4')
        const secondWorkspaceRoot = mkdtempSync(join(tmpdir(), 'hapi-machine-ws-2-'))
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot, secondWorkspaceRoot])

        listOpencodeModelsForCwdMock.mockResolvedValueOnce({
            success: true,
            availableModels: [{ modelId: 'x/y' }],
            currentModelId: 'x/y'
        })

        try {
            const result = await callListOpencodeModels(client, machine.id, secondWorkspaceRoot)
            expect(result).toEqual({
                success: true,
                availableModels: [{ modelId: 'x/y' }],
                currentModelId: 'x/y'
            })
            // The handler realpaths the cwd (security: prevents symlink escape),
            // so on macOS /var/folders/... resolves to /private/var/folders/...
            expect(listOpencodeModelsForCwdMock).toHaveBeenCalledWith(realpathSync.native(secondWorkspaceRoot))
        } finally {
            rmSync(secondWorkspaceRoot, { recursive: true, force: true })
            client.shutdown()
        }
    })
})

describe('ApiMachineClient listGrokModelsForCwd handler', () => {
    let workspaceRoot: string

    beforeEach(() => {
        ioMock.mockReset()
        listGrokModelsForCwdMock.mockReset()
        workspaceRoot = mkdtempSync(join(tmpdir(), 'hapi-grok-machine-ws-'))
    })

    afterEach(() => {
        rmSync(workspaceRoot, { recursive: true, force: true })
    })

    it('rejects cwd outside workspace roots before running grok models', async () => {
        const machine = makeMachine('grok-machine-1')
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])
        const outsideCwd = mkdtempSync(join(tmpdir(), 'hapi-grok-outside-'))

        try {
            expect(await callListGrokModels(client, machine.id, outsideCwd)).toEqual({
                success: false,
                error: 'Path is outside workspace roots'
            })
            expect(listGrokModelsForCwdMock).not.toHaveBeenCalled()
        } finally {
            rmSync(outsideCwd, { recursive: true, force: true })
            client.shutdown()
        }
    })

    it('forwards a workspace cwd to the Grok model probe', async () => {
        const machine = makeMachine('grok-machine-2')
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])
        listGrokModelsForCwdMock.mockResolvedValueOnce({
            success: true,
            availableModels: [{ modelId: 'grok-4.5' }],
            currentModelId: 'grok-4.5'
        })

        try {
            expect(await callListGrokModels(client, machine.id, workspaceRoot)).toEqual({
                success: true,
                availableModels: [{ modelId: 'grok-4.5' }],
                currentModelId: 'grok-4.5'
            })
            expect(listGrokModelsForCwdMock).toHaveBeenCalledWith(realpathSync.native(workspaceRoot))
        } finally {
            client.shutdown()
        }
    })
})

describe('ApiMachineClient Codex transcript handlers', () => {
    const originalCodexHome = process.env.CODEX_HOME
    let workspaceRoot: string
    let outsideRoot: string
    let codexHome: string

    beforeEach(() => {
        ioMock.mockReset()
        listOpencodeModelsForCwdMock.mockReset()
        workspaceRoot = mkdtempSync(join(tmpdir(), 'hapi-codex-allowed-'))
        outsideRoot = mkdtempSync(join(tmpdir(), 'hapi-codex-outside-'))
        codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-'))
        process.env.CODEX_HOME = codexHome
    })

    afterEach(() => {
        if (originalCodexHome === undefined) delete process.env.CODEX_HOME
        else process.env.CODEX_HOME = originalCodexHome
        rmSync(workspaceRoot, { recursive: true, force: true })
        rmSync(outsideRoot, { recursive: true, force: true })
        rmSync(codexHome, { recursive: true, force: true })
    })

    it('filters listed Codex sessions to workspace roots', async () => {
        writeCodexTranscript(codexHome, 'allowed.jsonl', {
            id: 'allowed-session-id',
            cwd: workspaceRoot
        }, 'allowed prompt')
        writeCodexTranscript(codexHome, 'outside.jsonl', {
            id: 'outside-session-id',
            cwd: outsideRoot
        }, 'outside prompt')

        const machine = makeMachine('codex-machine-1')
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])

        try {
            const result = await callListCodexSessions(client, machine.id, {})

            expect(result).toMatchObject({ success: true })
            const sessions = (result as { sessions: Array<{ id: string }> }).sessions
            expect(sessions.map((session) => session.id)).toEqual(['allowed-session-id'])
        } finally {
            client.shutdown()
        }
    })

    it('filters import-by-sessionId Codex sessions to workspace roots before returning message bodies', async () => {
        writeCodexTranscript(codexHome, 'allowed.jsonl', {
            id: 'allowed-session-id',
            cwd: workspaceRoot
        }, 'allowed prompt')
        writeCodexTranscript(codexHome, 'outside.jsonl', {
            id: 'outside-session-id',
            cwd: outsideRoot
        }, 'outside prompt')

        const machine = makeMachine('codex-machine-2')
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])

        try {
            const result = await callListCodexSessions(client, machine.id, {
                sessionIds: ['allowed-session-id', 'outside-session-id']
            })

            expect(result).toMatchObject({ success: true })
            const sessions = (result as { sessions: Array<{ id: string; messages?: unknown[] }> }).sessions
            expect(sessions.map((session) => session.id)).toEqual(['allowed-session-id'])
            expect(sessions[0]?.messages).toHaveLength(1)
        } finally {
            client.shutdown()
        }
    })

    it('rejects archive for Codex sessions outside workspace roots', async () => {
        const outsideFile = writeCodexTranscript(codexHome, 'outside.jsonl', {
            id: 'outside-session-id',
            cwd: outsideRoot
        }, 'outside prompt')

        const machine = makeMachine('codex-machine-3')
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])

        try {
            const result = await callArchiveCodexSession(client, machine.id, 'outside-session-id')

            expect(result).toEqual({ success: false, error: 'Codex session is outside workspace roots' })
            expect(existsSync(outsideFile)).toBe(true)
        } finally {
            client.shutdown()
        }
    })
})

describe('ApiMachineClient keepAlive lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('clears priming timeout on shutdown before first machine-alive emit', () => {
        const machine = makeMachine('machine-keepalive')
        const client = new ApiMachineClient('cli-token', machine)
        const emit = vi.fn()
        ;(client as unknown as { socket: { emit: typeof emit; close: () => void } }).socket = {
            emit,
            close: vi.fn(),
        } as never

        const priv = client as unknown as {
            startKeepAlive: () => void
            keepAliveInterval: NodeJS.Timeout | null
            keepAliveStartTimeout: ReturnType<typeof setTimeout> | null
        }

        priv.startKeepAlive()
        client.shutdown()
        vi.advanceTimersByTime(100)

        expect(emit).not.toHaveBeenCalled()
        expect(priv.keepAliveInterval).toBeNull()
        expect(priv.keepAliveStartTimeout).toBeNull()
    })

    it('clears running keepAlive interval on shutdown', () => {
        const machine = makeMachine('machine-keepalive-2')
        const client = new ApiMachineClient('cli-token', machine)
        const emit = vi.fn()
        ;(client as unknown as { socket: { emit: typeof emit; close: () => void } }).socket = {
            emit,
            close: vi.fn(),
        } as never

        const priv = client as unknown as {
            startKeepAlive: () => void
            keepAliveInterval: NodeJS.Timeout | null
        }

        priv.startKeepAlive()
        vi.advanceTimersByTime(50)
        expect(emit).toHaveBeenCalledTimes(1)

        client.shutdown()
        vi.advanceTimersByTime(20_000)

        expect(emit).toHaveBeenCalledTimes(1)
        expect(priv.keepAliveInterval).toBeNull()
    })
})
