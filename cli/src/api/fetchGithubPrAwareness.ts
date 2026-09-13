import axios from 'axios'
import { configuration } from '@/configuration'
import { getAuthToken } from '@/api/auth'
import { buildHubRequestHeaders } from '@/api/hubExtraHeaders'

/**
 * Hub-global githubPrAwareness flag (default off). Used to gate MCP `link_pr`.
 * Fail closed: network/auth errors → false.
 */
export async function fetchGithubPrAwarenessEnabled(): Promise<boolean> {
    try {
        const token = getAuthToken()
        const response = await axios.get(
            `${configuration.apiUrl}/cli/features`,
            {
                headers: buildHubRequestHeaders({
                    Authorization: `Bearer ${token}`
                }),
                timeout: 5_000,
                validateStatus: () => true
            }
        )
        if (response.status < 200 || response.status >= 300) {
            return false
        }
        return response.data?.githubPrAwareness?.enabled === true
    } catch {
        return false
    }
}
