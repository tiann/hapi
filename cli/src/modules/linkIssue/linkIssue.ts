import axios from 'axios'
import { configuration } from '@/configuration'
import { getAuthToken } from '@/api/auth'
import { buildHubRequestHeaders } from '@/api/hubExtraHeaders'

export class LinkIssueError extends Error {
    code: 'bad_args' | 'auth_failed' | 'request_failed'

    constructor(code: LinkIssueError['code'], message: string) {
        super(message)
        this.name = 'LinkIssueError'
        this.code = code
    }
}

const AUTH_RECOVERY_HINT =
    'On a remote runner, set HAPI_API_URL to the runner hub, and set CLI_API_TOKEN ' +
    'or run `hapi auth login` to save the token.'

function resolveApiUrl(): string {
    const raw = configuration.apiUrl.trim().replace(/\/+$/, '')
    if (!raw) {
        throw new LinkIssueError('bad_args', `HAPI API URL is empty. ${AUTH_RECOVERY_HINT}`)
    }
    return raw
}

function resolveAccessToken(): string {
    let token = ''
    try {
        token = getAuthToken().trim()
    } catch {
        token = ''
    }
    if (!token) {
        throw new LinkIssueError('bad_args', `CLI_API_TOKEN is required (run \`hapi auth login\`). ${AUTH_RECOVERY_HINT}`)
    }
    return token
}

async function exchangeJwt(apiUrl: string, accessToken: string): Promise<string> {
    try {
        const response = await axios.post(
            `${apiUrl}/api/auth`,
            { accessToken },
            { headers: buildHubRequestHeaders({ 'Content-Type': 'application/json' }), timeout: 10_000, validateStatus: () => true }
        )
        const token = typeof response.data?.token === 'string' ? response.data.token : ''
        if (response.status < 200 || response.status >= 300 || !token) {
            const detail = typeof response.data?.error === 'string' ? response.data.error : `HTTP ${response.status}`
            throw new LinkIssueError('auth_failed', `failed to exchange access token for JWT (${detail}). ${AUTH_RECOVERY_HINT}`)
        }
        return token
    } catch (error) {
        if (error instanceof LinkIssueError) throw error
        throw new LinkIssueError('auth_failed', `failed to exchange access token for JWT (${error instanceof Error ? error.message : String(error)}). ${AUTH_RECOVERY_HINT}`)
    }
}

/**
 * Self-session only — resolves which session to attach the issue to from
 * `HAPI_SESSION_ID`, the env var every HAPI-wrapped agent process already
 * inherits (`cli/src/agent/hapiSessionEnv.ts`), rather than taking a session
 * id argument. Mirrors the auth/JWT-exchange plumbing already established
 * in `cli/src/modules/pingPeer/pingPeer.ts` (kept local here rather than
 * exported from that module — peer-messaging and self-session metadata
 * writes are different enough concerns that sharing just the HTTP
 * boilerplate isn't worth coupling the two modules).
 */
export async function linkIssue(sessionId: string, url: string): Promise<void> {
    if (!sessionId) {
        throw new LinkIssueError('bad_args', 'HAPI_SESSION_ID is not set — this command only works from inside a running HAPI session.')
    }
    const apiUrl = resolveApiUrl()
    const accessToken = resolveAccessToken()
    const jwt = await exchangeJwt(apiUrl, accessToken)

    const response = await axios.patch(
        `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/link-issue`,
        { url },
        {
            headers: buildHubRequestHeaders({ Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }),
            timeout: 10_000,
            validateStatus: () => true
        }
    )
    if (response.status < 200 || response.status >= 300) {
        const detail = typeof response.data?.error === 'string' ? response.data.error : `HTTP ${response.status}`
        throw new LinkIssueError('request_failed', detail)
    }
}
