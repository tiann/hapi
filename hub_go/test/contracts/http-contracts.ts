export type HttpContract = {
    path: string
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    request?: {
        body?: Record<string, unknown>
        query?: Record<string, string>
        headers?: Record<string, string>
    }
    response: {
        status: number
        body: Record<string, unknown> | null
    }
}

export const httpContracts: HttpContract[] = [
    { path: '/health', method: 'GET', response: { status: 200, body: { status: 'ok', protocolVersion: 0 } } },

    { path: '/api/auth', method: 'POST', request: { body: { initData: 'string' } }, response: { status: 200, body: { token: 'string', user: {} } } },
    { path: '/api/auth', method: 'POST', request: { body: { accessToken: 'string' } }, response: { status: 200, body: { token: 'string', user: {} } } },
    { path: '/api/bind', method: 'POST', request: { body: { initData: 'string', accessToken: 'string' } }, response: { status: 200, body: { token: 'string', user: {} } } },

    { path: '/api/sessions', method: 'GET', response: { status: 200, body: { sessions: [] } } },
    { path: '/api/sessions/:id', method: 'GET', response: { status: 200, body: { session: {} } } },
    { path: '/api/sessions/:id/resume', method: 'POST', response: { status: 200, body: { type: 'success', sessionId: 'string' } } },
    { path: '/api/sessions/:id/abort', method: 'POST', response: { status: 200, body: { ok: true } } },
    { path: '/api/sessions/:id/archive', method: 'POST', response: { status: 200, body: { ok: true } } },
    { path: '/api/sessions/:id/switch', method: 'POST', response: { status: 200, body: { ok: true } } },
    { path: '/api/sessions/:id', method: 'PATCH', request: { body: { name: 'string' } }, response: { status: 200, body: { ok: true } } },
    { path: '/api/sessions/:id', method: 'DELETE', response: { status: 200, body: { ok: true } } },
    { path: '/api/sessions/:id/permission-mode', method: 'POST', request: { body: { mode: 'string' } }, response: { status: 200, body: { ok: true } } },
    { path: '/api/sessions/:id/model', method: 'POST', request: { body: { model: 'string' } }, response: { status: 200, body: { ok: true } } },
    { path: '/api/sessions/:id/slash-commands', method: 'GET', response: { status: 200, body: { success: true } } },
    { path: '/api/sessions/:id/skills', method: 'GET', response: { status: 200, body: { success: true } } },
    { path: '/api/sessions/:id/upload', method: 'POST', request: { body: { filename: 'string', content: 'base64', mimeType: 'string' } }, response: { status: 200, body: { success: true } } },
    { path: '/api/sessions/:id/upload/delete', method: 'POST', request: { body: { path: 'string' } }, response: { status: 200, body: { success: true } } },

    { path: '/api/sessions/:id/messages', method: 'GET', request: { query: { limit: '50', beforeSeq: '0' } }, response: { status: 200, body: { messages: [], page: {} } } },
    { path: '/api/sessions/:id/messages', method: 'POST', request: { body: { text: 'string', attachments: [] } }, response: { status: 200, body: { ok: true } } },

    { path: '/api/machines', method: 'GET', response: { status: 200, body: { machines: [] } } },
    { path: '/api/machines/:id/spawn', method: 'POST', request: { body: { directory: 'string' } }, response: { status: 200, body: {} } },
    { path: '/api/machines/:id/paths/exists', method: 'POST', request: { body: { paths: [] } }, response: { status: 200, body: { exists: {} } } },

    { path: '/api/sessions/:id/permissions/:requestId/approve', method: 'POST', request: { body: {} }, response: { status: 200, body: { ok: true } } },
    { path: '/api/sessions/:id/permissions/:requestId/deny', method: 'POST', request: { body: {} }, response: { status: 200, body: { ok: true } } },

    { path: '/api/sessions/:id/git-status', method: 'GET', response: { status: 200, body: { success: true } } },
    { path: '/api/sessions/:id/git-diff-numstat', method: 'GET', request: { query: { staged: 'false' } }, response: { status: 200, body: { success: true } } },
    { path: '/api/sessions/:id/git-diff-file', method: 'GET', request: { query: { path: 'string', staged: 'false' } }, response: { status: 200, body: { success: true } } },
    { path: '/api/sessions/:id/file', method: 'GET', request: { query: { path: 'string' } }, response: { status: 200, body: { success: true } } },
    { path: '/api/sessions/:id/files', method: 'GET', request: { query: { query: 'string', limit: '200' } }, response: { status: 200, body: { success: true, files: [] } } },

    { path: '/api/push/vapid-public-key', method: 'GET', response: { status: 200, body: { publicKey: 'string' } } },
    { path: '/api/push/subscribe', method: 'POST', request: { body: { endpoint: 'string', keys: { p256dh: 'string', auth: 'string' } } }, response: { status: 200, body: { ok: true } } },
    { path: '/api/push/subscribe', method: 'DELETE', request: { body: { endpoint: 'string' } }, response: { status: 200, body: { ok: true } } },

    { path: '/api/voice/token', method: 'POST', request: { body: { customAgentId: 'string', customApiKey: 'string' } }, response: { status: 200, body: { allowed: true, token: 'string' } } },

    { path: '/api/events', method: 'GET', request: { query: { all: 'true', sessionId: 'string', machineId: 'string', visibility: 'visible', token: 'string' } }, response: { status: 200, body: null } },
    { path: '/api/visibility', method: 'POST', request: { body: { subscriptionId: 'string', visibility: 'visible' } }, response: { status: 200, body: { ok: true } } },

    { path: '/cli/sessions', method: 'POST', request: { body: { tag: 'string', metadata: {}, agentState: null } }, response: { status: 200, body: { session: {} } } },
    { path: '/cli/sessions/:id', method: 'GET', response: { status: 200, body: { session: {} } } },
    { path: '/cli/sessions/:id/messages', method: 'GET', request: { query: { afterSeq: '0', limit: '200' } }, response: { status: 200, body: { messages: [] } } },
    { path: '/cli/machines', method: 'POST', request: { body: { id: 'string', metadata: {}, runnerState: null } }, response: { status: 200, body: { machine: {} } } },
    { path: '/cli/machines/:id', method: 'GET', response: { status: 200, body: { machine: {} } } }
]
