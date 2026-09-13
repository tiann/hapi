import axios from 'axios'
import type { ExternalRef, GithubPrExternalRef } from '@hapi/protocol'
import { configuration } from '@/configuration'
import { getAuthToken } from '@/api/auth'
import { buildHubRequestHeaders } from '@/api/hubExtraHeaders'

export type UpsertSessionExternalRefResult = {
    ok: boolean
    status: number
    error?: string
    externalRefs?: ExternalRef[]
}

export async function upsertSessionExternalRef(
    sessionId: string,
    ref: GithubPrExternalRef
): Promise<UpsertSessionExternalRefResult> {
    const response = await axios.post(
        `${configuration.apiUrl}/cli/sessions/${encodeURIComponent(sessionId)}/external-refs/upsert`,
        { ref },
        {
            headers: buildHubRequestHeaders({
                Authorization: `Bearer ${getAuthToken()}`,
                'Content-Type': 'application/json'
            }),
            timeout: 30_000,
            validateStatus: () => true
        }
    )

    if (response.status >= 200 && response.status < 300) {
        const externalRefs = Array.isArray(response.data?.externalRefs)
            ? response.data.externalRefs as ExternalRef[]
            : undefined
        return { ok: true, status: response.status, externalRefs }
    }

    const error = typeof response.data?.error === 'string'
        ? response.data.error
        : `HTTP ${response.status}`
    return { ok: false, status: response.status, error }
}
