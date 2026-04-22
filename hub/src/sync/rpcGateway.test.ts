import { describe, expect, it } from 'bun:test'
import { RpcGateway } from './rpcGateway'
import { RpcRegistry } from '../socket/rpcRegistry'

describe('RpcGateway', () => {
    it('sends list-importable-sessions rpc requests and parses the response shape', async () => {
        const registry = new RpcRegistry()
        const captured: Array<{ event: string; payload: { method: string; params: string } }> = []

        const socket = {
            id: 'socket-1',
            timeout: () => ({
                emitWithAck: async (event: string, payload: { method: string; params: string }) => {
                    captured.push({ event, payload })
                    return {
                        sessions: [
                            {
                                agent: 'codex',
                                externalSessionId: 'session-1',
                                cwd: '/tmp/project',
                                timestamp: 123,
                                transcriptPath: '/tmp/project/.codex/sessions/session-1.jsonl',
                                previewTitle: 'Imported title',
                                previewPrompt: 'Imported prompt',
                                ignoredField: 'strip-me'
                            }
                        ],
                        ignoredResponseField: true
                    }
                }
            })
        }

        registry.register(socket as never, 'machine-1:list-importable-sessions')

        const io = {
            of: () => ({
                sockets: new Map([['socket-1', socket]])
            })
        }

        const gateway = new RpcGateway(io as never, registry)

        await expect(gateway.listImportableSessions('machine-1', { agent: 'codex' })).resolves.toEqual({
            sessions: [
                {
                    agent: 'codex',
                    externalSessionId: 'session-1',
                    cwd: '/tmp/project',
                    timestamp: 123,
                    transcriptPath: '/tmp/project/.codex/sessions/session-1.jsonl',
                    previewTitle: 'Imported title',
                    previewPrompt: 'Imported prompt'
                }
            ]
        })
        expect(captured).toEqual([
            {
                event: 'rpc-request',
                payload: {
                    method: 'machine-1:list-importable-sessions',
                    params: JSON.stringify({ agent: 'codex' })
                }
            }
        ])
    })

    it('parses claude list-importable-sessions responses', async () => {
        const registry = new RpcRegistry()

        const socket = {
            id: 'socket-1',
            timeout: () => ({
                emitWithAck: async () => ({
                    sessions: [
                        {
                            agent: 'claude',
                            externalSessionId: 'claude-session-1',
                            cwd: '/work/project',
                            timestamp: 1712131200000,
                            transcriptPath: '/tmp/claude-session-1.jsonl',
                            previewTitle: 'Fix the API',
                            previewPrompt: 'Please fix the API'
                        }
                    ]
                })
            })
        }

        registry.register(socket as never, 'machine-1:list-importable-sessions')

        const io = {
            of: () => ({
                sockets: new Map([['socket-1', socket]])
            })
        }

        const gateway = new RpcGateway(io as never, registry)

        await expect(gateway.listImportableSessions('machine-1', { agent: 'claude' })).resolves.toEqual({
            sessions: [
                {
                    agent: 'claude',
                    externalSessionId: 'claude-session-1',
                    cwd: '/work/project',
                    timestamp: 1712131200000,
                    transcriptPath: '/tmp/claude-session-1.jsonl',
                    previewTitle: 'Fix the API',
                    previewPrompt: 'Please fix the API'
                }
            ]
        })
    })

    it('rejects malformed list-importable-sessions responses', async () => {
        const registry = new RpcRegistry()

        const socket = {
            id: 'socket-1',
            timeout: () => ({
                emitWithAck: async () => ({
                    sessions: [
                        {
                            agent: 'codex',
                            externalSessionId: 123,
                            cwd: '/tmp/project',
                            timestamp: 'not-a-number',
                            transcriptPath: '/tmp/project/.codex/sessions/session-1.jsonl',
                            previewTitle: null,
                            previewPrompt: null
                        }
                    ]
                })
            })
        }

        registry.register(socket as never, 'machine-1:list-importable-sessions')

        const io = {
            of: () => ({
                sockets: new Map([['socket-1', socket]])
            })
        }

        const gateway = new RpcGateway(io as never, registry)

        await expect(gateway.listImportableSessions('machine-1', { agent: 'codex' })).rejects.toThrow()
    })

    it('rejects list-importable-sessions responses whose session agent does not match the request agent', async () => {
        const registry = new RpcRegistry()

        const socket = {
            id: 'socket-1',
            timeout: () => ({
                emitWithAck: async () => ({
                    sessions: [
                        {
                            agent: 'claude',
                            externalSessionId: 'claude-session-1',
                            cwd: '/tmp/project',
                            timestamp: 123,
                            transcriptPath: '/tmp/project/session-1.jsonl',
                            previewTitle: 'Imported title',
                            previewPrompt: 'Imported prompt'
                        }
                    ]
                })
            })
        }

        registry.register(socket as never, 'machine-1:list-importable-sessions')

        const io = {
            of: () => ({
                sockets: new Map([['socket-1', socket]])
            })
        }

        const gateway = new RpcGateway(io as never, registry)

        await expect(gateway.listImportableSessions('machine-1', { agent: 'codex' })).rejects.toThrow(
            'Unexpected importable session agent "claude" for request "codex"'
        )
    })
})
