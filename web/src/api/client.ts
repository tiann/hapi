import type {
    AuthResponse,
    FileReadResponse,
    FileSearchResponse,
    GitCommandResponse,
    MachinesResponse,
    MessagesResponse,
    SpawnResponse,
    SessionResponse,
    SessionsResponse
} from '@/types/api'

export class ApiClient {
    private token: string

    constructor(token: string) {
        this.token = token
    }

    private async request<T>(path: string, init?: RequestInit): Promise<T> {
        const headers = new Headers(init?.headers)
        headers.set('authorization', `Bearer ${this.token}`)
        if (init?.body !== undefined && !headers.has('content-type')) {
            headers.set('content-type', 'application/json')
        }

        const res = await fetch(path, {
            ...init,
            headers
        })

        if (!res.ok) {
            const body = await res.text().catch(() => '')
            throw new Error(`HTTP ${res.status} ${res.statusText}: ${body}`)
        }

        return await res.json() as T
    }

    async authenticate(auth: { initData: string } | { accessToken: string }): Promise<AuthResponse> {
        const res = await fetch('/api/auth', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(auth)
        })

        if (!res.ok) {
            const body = await res.text().catch(() => '')
            throw new Error(`Auth failed: HTTP ${res.status} ${res.statusText}: ${body}`)
        }

        return await res.json() as AuthResponse
    }

    async getSessions(): Promise<SessionsResponse> {
        return await this.request<SessionsResponse>('/api/sessions')
    }

    async getSession(sessionId: string): Promise<SessionResponse> {
        return await this.request<SessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}`)
    }

    async getMessages(sessionId: string, options: { beforeSeq?: number | null; limit?: number }): Promise<MessagesResponse> {
        const params = new URLSearchParams()
        if (options.beforeSeq !== undefined && options.beforeSeq !== null) {
            params.set('beforeSeq', `${options.beforeSeq}`)
        }
        if (options.limit !== undefined && options.limit !== null) {
            params.set('limit', `${options.limit}`)
        }

        const qs = params.toString()
        const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`
        return await this.request<MessagesResponse>(url)
    }

    async getGitStatus(sessionId: string): Promise<GitCommandResponse> {
        return await this.request<GitCommandResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/git-status`)
    }

    async getGitDiffNumstat(sessionId: string, staged: boolean): Promise<GitCommandResponse> {
        const params = new URLSearchParams()
        params.set('staged', staged ? 'true' : 'false')
        return await this.request<GitCommandResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/git-diff-numstat?${params.toString()}`)
    }

    async getGitDiffFile(sessionId: string, path: string, staged?: boolean): Promise<GitCommandResponse> {
        const params = new URLSearchParams()
        params.set('path', path)
        if (staged !== undefined) {
            params.set('staged', staged ? 'true' : 'false')
        }
        return await this.request<GitCommandResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/git-diff-file?${params.toString()}`)
    }

    async searchSessionFiles(sessionId: string, query: string, limit?: number): Promise<FileSearchResponse> {
        const params = new URLSearchParams()
        if (query) {
            params.set('query', query)
        }
        if (limit !== undefined) {
            params.set('limit', `${limit}`)
        }
        const qs = params.toString()
        return await this.request<FileSearchResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/files${qs ? `?${qs}` : ''}`)
    }

    async readSessionFile(sessionId: string, path: string): Promise<FileReadResponse> {
        const params = new URLSearchParams()
        params.set('path', path)
        return await this.request<FileReadResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/file?${params.toString()}`)
    }

    async sendMessage(sessionId: string, text: string, localId?: string | null): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
            method: 'POST',
            body: JSON.stringify({ text, localId: localId ?? undefined })
        })
    }

    async abortSession(sessionId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async setPermissionMode(sessionId: string, mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permission-mode`, {
            method: 'POST',
            body: JSON.stringify({ mode })
        })
    }

    async setModelMode(sessionId: string, model: 'default' | 'sonnet' | 'opus'): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/model`, {
            method: 'POST',
            body: JSON.stringify({ model })
        })
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        modeOrOptions?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | {
            mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
            allowTools?: string[]
            decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
            answers?: Record<string, string[]>
        }
    ): Promise<void> {
        const body = typeof modeOrOptions === 'string' || modeOrOptions === undefined
            ? { mode: modeOrOptions }
            : modeOrOptions
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/approve`, {
            method: 'POST',
            body: JSON.stringify(body)
        })
    }

    async denyPermission(
        sessionId: string,
        requestId: string,
        options?: {
            decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
        }
    ): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/deny`, {
            method: 'POST',
            body: JSON.stringify(options ?? {})
        })
    }

    async getMachines(): Promise<MachinesResponse> {
        return await this.request<MachinesResponse>('/api/machines')
    }

    async spawnSession(machineId: string, directory: string, agent?: 'claude' | 'codex'): Promise<SpawnResponse> {
        return await this.request<SpawnResponse>(`/api/machines/${encodeURIComponent(machineId)}/spawn`, {
            method: 'POST',
            body: JSON.stringify({ directory, agent })
        })
    }
}
