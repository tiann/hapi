import { describe, expect, it } from 'bun:test'
import type { Server } from 'socket.io'
import { PERMISSION_REQUEST_NOT_FOUND_MESSAGE } from '@hapi/protocol/rpcMethods'
import type { RpcRegistry } from '../socket/rpcRegistry'
import { PermissionRequestNotFoundError, RpcGateway, RpcTargetMissingError } from './rpcGateway'

function createGateway() {
    const timeouts: number[] = []
    const calls: Array<{ method: string; params: string }> = []
    const socket = {
        timeout(timeoutMs: number) {
            timeouts.push(timeoutMs)
            return {
                async emitWithAck(_event: string, payload: { method: string; params: string }) {
                    calls.push(payload)
                    if (payload.method.endsWith(':cursor-chat-store-status')) {
                        return JSON.stringify({ onDisk: false, store: null })
                    }
                    return JSON.stringify({
                        success: true,
                        method: payload.method,
                        params: JSON.parse(payload.params) as unknown
                    })
                }
            }
        }
    }

    const io = {
        of() {
            return {
                sockets: {
                    get() {
                        return socket
                    }
                }
            }
        }
    } as unknown as Server

    const rpcRegistry = {
        getSocketIdForMethod() {
            return 'socket-1'
        }
    } as unknown as RpcRegistry

    return {
        gateway: new RpcGateway(io, rpcRegistry),
        timeouts,
        calls
    }
}

describe('RpcGateway RPC timeouts', () => {
    it('uses the default RPC timeout for regular machine RPCs', async () => {
        const { gateway, timeouts } = createGateway()

        await gateway.listMachineDirectory('machine-1', 'C:\\workspace')

        expect(timeouts).toEqual([30_000])
    })

    it('uses an extended RPC timeout when listing Codex models', async () => {
        const { gateway, timeouts } = createGateway()

        await gateway.listCodexModelsForMachine('machine-1')

        expect(timeouts).toEqual([120_000])
    })

    it('uses the session RPC for explicit Codex fallback discovery', async () => {
        const { gateway, calls, timeouts } = createGateway()

        await gateway.listCodexModelsForSession('session-1')

        expect(calls.map((call) => call.method)).toEqual(['session-1:listCodexModels'])
        expect(timeouts).toEqual([120_000])
    })

    it('uses an extended RPC timeout when listing Cursor models for a machine', async () => {
        const { gateway, timeouts } = createGateway()

        await gateway.listCursorModelsForMachine('machine-1')

        expect(timeouts).toEqual([120_000])
    })

    it('uses an extended RPC timeout when listing Copilot models', async () => {
        const { gateway, timeouts } = createGateway()

        await gateway.listCopilotModelsForCwd('machine-1', '/workspace')
        await gateway.listCopilotModelsForSession('session-1')

        expect(timeouts).toEqual([120_000, 120_000])
    })

    it('forwards the recorded session owner home to the Cursor store probe', async () => {
        const { gateway, calls } = createGateway()

        await gateway.getCursorChatStoreStatus(
            'machine-1',
            '/workspace/project',
            'cursor-session',
            '/home/recorded-owner'
        )

        expect(calls).toEqual([{
            method: 'machine-1:cursor-chat-store-status',
            params: JSON.stringify({
                workspacePath: '/workspace/project',
                cursorSessionId: 'cursor-session',
                homeDir: '/home/recorded-owner'
            })
        }])
    })
})

// tiann/hapi#916: rpcCall throws a typed `RpcTargetMissingError` when the
// target CLI is unreachable, so syncEngine.archiveSession can narrow on it
// and treat the kill as a benign no-op.
describe('RpcGateway no-target diagnostics (tiann/hapi#916)', () => {
    it('throws RpcTargetMissingError(handler-not-registered) when no socket is registered for the method', async () => {
        const io = {
            of() {
                return {
                    sockets: {
                        get() { return undefined }
                    }
                }
            }
        } as unknown as Server
        const rpcRegistry = {
            getSocketIdForMethod() { return undefined }
        } as unknown as RpcRegistry
        const gateway = new RpcGateway(io, rpcRegistry)

        const error = await gateway.killSession('session-1').catch((e: unknown) => e)
        expect(error).toBeInstanceOf(RpcTargetMissingError)
        expect((error as RpcTargetMissingError).code).toBe('handler-not-registered')
    })

    it('throws RpcTargetMissingError(socket-disconnected) when the socket id is registered but no socket exists', async () => {
        const io = {
            of() {
                return {
                    sockets: {
                        get() { return undefined }
                    }
                }
            }
        } as unknown as Server
        const rpcRegistry = {
            getSocketIdForMethod() { return 'socket-1' }
        } as unknown as RpcRegistry
        const gateway = new RpcGateway(io, rpcRegistry)

        const error = await gateway.killSession('session-1').catch((e: unknown) => e)
        expect(error).toBeInstanceOf(RpcTargetMissingError)
        expect((error as RpcTargetMissingError).code).toBe('socket-disconnected')
    })
})

// tiann/hapi#1735: a stale/canceled permission request answer must surface as
// a real error, not resolve as if it had been accepted.
describe('RpcGateway permission RPC error surfacing (tiann/hapi#1735)', () => {
    function createGatewayWithResponse(errorMessage: string) {
        const socket = {
            timeout() {
                return {
                    async emitWithAck() {
                        return JSON.stringify({ error: errorMessage })
                    }
                }
            }
        }
        const io = {
            of() {
                return { sockets: { get() { return socket } } }
            }
        } as unknown as Server
        const rpcRegistry = {
            getSocketIdForMethod() { return 'socket-1' }
        } as unknown as RpcRegistry
        return new RpcGateway(io, rpcRegistry)
    }

    it('throws PermissionRequestNotFoundError when the CLI reports no pending request for approve', async () => {
        const gateway = createGatewayWithResponse(PERMISSION_REQUEST_NOT_FOUND_MESSAGE)
        const error = await gateway.approvePermission('session-1', 'request-1').catch((e: unknown) => e)
        expect(error).toBeInstanceOf(PermissionRequestNotFoundError)
    })

    it('throws PermissionRequestNotFoundError when the CLI reports no pending request for deny', async () => {
        const gateway = createGatewayWithResponse(PERMISSION_REQUEST_NOT_FOUND_MESSAGE)
        const error = await gateway.denyPermission('session-1', 'request-1').catch((e: unknown) => e)
        expect(error).toBeInstanceOf(PermissionRequestNotFoundError)
    })

    it('does not relabel an unrelated RPC error as PermissionRequestNotFoundError', async () => {
        const gateway = createGatewayWithResponse('Some other failure unrelated to a missing request')
        // Only the specific shared message is treated as "not found"; anything
        // else on this RPC method currently resolves rather than being
        // mislabeled — a narrower, orthogonal gap than what this PR fixes.
        await expect(gateway.approvePermission('session-1', 'request-1')).resolves.toBeUndefined()
    })

    it('resolves normally when the CLI accepts the answer', async () => {
        const { gateway } = createGateway()
        await expect(gateway.approvePermission('session-1', 'request-1')).resolves.toBeUndefined()
    })
})
