export type SocketEventContract = {
    namespace: '/cli' | '/terminal'
    direction: 'client->server' | 'server->client'
    event: string
    payload: Record<string, unknown>
    ack?: Record<string, unknown>
}

export const socketContracts: SocketEventContract[] = [
    { namespace: '/cli', direction: 'client->server', event: 'message', payload: { sid: 'string', message: {}, localId: 'string?' } },
    { namespace: '/cli', direction: 'client->server', event: 'session-alive', payload: { sid: 'string', time: 0, thinking: false, mode: 'local', permissionMode: 'string?', modelMode: 'string?' } },
    { namespace: '/cli', direction: 'client->server', event: 'session-end', payload: { sid: 'string', time: 0 } },
    { namespace: '/cli', direction: 'client->server', event: 'update-metadata', payload: { sid: 'string', expectedVersion: 0, metadata: {} }, ack: { result: 'success', version: 1, metadata: {} } },
    { namespace: '/cli', direction: 'client->server', event: 'update-state', payload: { sid: 'string', expectedVersion: 0, agentState: {} }, ack: { result: 'success', version: 1, agentState: {} } },
    { namespace: '/cli', direction: 'client->server', event: 'machine-alive', payload: { machineId: 'string', time: 0 } },
    { namespace: '/cli', direction: 'client->server', event: 'machine-update-metadata', payload: { machineId: 'string', expectedVersion: 0, metadata: {} }, ack: { result: 'success', version: 1, metadata: {} } },
    { namespace: '/cli', direction: 'client->server', event: 'machine-update-state', payload: { machineId: 'string', expectedVersion: 0, runnerState: {} }, ack: { result: 'success', version: 1, runnerState: {} } },
    { namespace: '/cli', direction: 'client->server', event: 'rpc-register', payload: { method: 'string' } },
    { namespace: '/cli', direction: 'client->server', event: 'rpc-unregister', payload: { method: 'string' } },
    { namespace: '/cli', direction: 'client->server', event: 'terminal:ready', payload: { sessionId: 'string', terminalId: 'string' } },
    { namespace: '/cli', direction: 'client->server', event: 'terminal:output', payload: { sessionId: 'string', terminalId: 'string', data: 'string' } },
    { namespace: '/cli', direction: 'client->server', event: 'terminal:exit', payload: { sessionId: 'string', terminalId: 'string', code: 0, signal: 'string' } },
    { namespace: '/cli', direction: 'client->server', event: 'terminal:error', payload: { sessionId: 'string', terminalId: 'string', message: 'string' } },
    { namespace: '/cli', direction: 'client->server', event: 'ping', payload: {}, ack: {} },

    { namespace: '/cli', direction: 'server->client', event: 'update', payload: { id: 'string', seq: 0, createdAt: 0, body: {} } },
    { namespace: '/cli', direction: 'server->client', event: 'rpc-request', payload: { method: 'string', params: 'string' }, ack: 'string' as unknown as Record<string, unknown> },
    { namespace: '/cli', direction: 'server->client', event: 'terminal:open', payload: { sessionId: 'string', terminalId: 'string', cols: 80, rows: 24 } },
    { namespace: '/cli', direction: 'server->client', event: 'terminal:write', payload: { sessionId: 'string', terminalId: 'string', data: 'string' } },
    { namespace: '/cli', direction: 'server->client', event: 'terminal:resize', payload: { sessionId: 'string', terminalId: 'string', cols: 80, rows: 24 } },
    { namespace: '/cli', direction: 'server->client', event: 'terminal:close', payload: { sessionId: 'string', terminalId: 'string' } },
    { namespace: '/cli', direction: 'server->client', event: 'error', payload: { message: 'string', code: 'string?', scope: 'session', id: 'string' } },

    { namespace: '/terminal', direction: 'client->server', event: 'terminal:create', payload: { sessionId: 'string', terminalId: 'string', cols: 80, rows: 24 } },
    { namespace: '/terminal', direction: 'client->server', event: 'terminal:write', payload: { terminalId: 'string', data: 'string' } },
    { namespace: '/terminal', direction: 'client->server', event: 'terminal:resize', payload: { terminalId: 'string', cols: 80, rows: 24 } },
    { namespace: '/terminal', direction: 'client->server', event: 'terminal:close', payload: { terminalId: 'string' } },

    { namespace: '/terminal', direction: 'server->client', event: 'terminal:ready', payload: { sessionId: 'string', terminalId: 'string' } },
    { namespace: '/terminal', direction: 'server->client', event: 'terminal:output', payload: { sessionId: 'string', terminalId: 'string', data: 'string' } },
    { namespace: '/terminal', direction: 'server->client', event: 'terminal:exit', payload: { sessionId: 'string', terminalId: 'string', code: 0, signal: 'string' } },
    { namespace: '/terminal', direction: 'server->client', event: 'terminal:error', payload: { terminalId: 'string', message: 'string' } }
]
