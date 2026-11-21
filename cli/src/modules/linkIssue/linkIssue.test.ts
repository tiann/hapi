import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configuration } from '@/configuration'

const axiosPostMock = vi.hoisted(() => vi.fn())
const axiosPatchMock = vi.hoisted(() => vi.fn())

vi.mock('axios', () => ({
    default: {
        post: axiosPostMock,
        patch: axiosPatchMock,
        isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: boolean } | null)?.isAxiosError)
    }
}))

vi.mock('@/api/auth', () => ({
    getAuthToken: () => 'cli-token'
}))

import { linkIssue, LinkIssueError } from './linkIssue'

describe('linkIssue', () => {
    beforeEach(() => {
        configuration._setApiUrl('https://hapi.example.com')
        axiosPostMock.mockReset()
        axiosPatchMock.mockReset()
        axiosPostMock.mockResolvedValue({ status: 200, data: { token: 'hub-jwt' } })
    })

    it('links the issue when both requests succeed', async () => {
        axiosPatchMock.mockResolvedValue({ status: 200, data: {} })
        await expect(linkIssue('session-1', 'https://github.com/owner/repo/issues/1')).resolves.toBeUndefined()
    })

    // Review finding (tiann/hapi#2147, round 14): the PATCH request carries
    // a live bearer JWT. A transport-level failure (timeout, connection
    // refused) used to throw the raw AxiosError straight out of linkIssue(),
    // which the command layer's DEBUG path then logged whole — printing the
    // Authorization header to the terminal. Must convert to a LinkIssueError
    // carrying only the transport error code, never the raw error object
    // (which would carry the request config, headers included).
    it('wraps a transport-level failure on the authenticated request into a LinkIssueError without leaking the raw error', async () => {
        const transportError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3006'), {
            isAxiosError: true,
            code: 'ECONNREFUSED',
            config: { headers: { Authorization: 'Bearer hub-jwt' } }
        })
        axiosPatchMock.mockRejectedValue(transportError)

        let caught: unknown
        try {
            await linkIssue('session-1', 'https://github.com/owner/repo/issues/1')
        } catch (error) {
            caught = error
        }

        expect(caught).toBeInstanceOf(LinkIssueError)
        expect((caught as LinkIssueError).code).toBe('request_failed')
        expect((caught as Error).message).not.toContain('Bearer')
        expect((caught as Error).message).not.toContain('hub-jwt')
        expect((caught as Error).message).toContain('ECONNREFUSED')
    })

    // Same hardening applied to the JWT-exchange request's own catch
    // (review finding, tiann/hapi#2147, round 14, cold-review follow-up):
    // consistency with the PATCH fix above, not a proven leak on this path
    // (the access token goes in the POST body, not a header) — but no
    // reason this call should trust a raw error's stringification either.
    it('wraps a transport-level failure on the JWT exchange without embedding the raw error message', async () => {
        const transportError = Object.assign(new Error('timeout of 10000ms exceeded'), {
            isAxiosError: true,
            code: 'ETIMEDOUT'
        })
        axiosPostMock.mockRejectedValue(transportError)

        let caught: unknown
        try {
            await linkIssue('session-1', 'https://github.com/owner/repo/issues/1')
        } catch (error) {
            caught = error
        }

        expect(caught).toBeInstanceOf(LinkIssueError)
        expect((caught as LinkIssueError).code).toBe('auth_failed')
        expect((caught as Error).message).not.toContain('timeout of 10000ms exceeded')
        expect((caught as Error).message).toContain('ETIMEDOUT')
    })
})
