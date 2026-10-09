import { beforeEach, describe, expect, it } from 'vitest'
import { AxiosHeaders } from 'axios'
import { clearProxyAgentCache } from '@hapi/protocol/net'
import {
    axiosEgressConfig,
    proxyAwareAxiosInterceptor,
    resetProxyAwareAxiosForTests,
    socketIoProxyOptions
} from './proxy'

const PROXY = 'http://user:pass@proxy.example:7890'

function proxiedHref(agent: unknown): string | undefined {
    return (agent as { proxy?: { href?: string } } | undefined)?.proxy?.href
}

describe('socketIoProxyOptions', () => {
    beforeEach(() => {
        clearProxyAgentCache()
        resetProxyAwareAxiosForTests()
    })

    it('injects an HttpsProxyAgent for proxied wss hubs', () => {
        const options = socketIoProxyOptions('https://hub.example.com', { HTTPS_PROXY: PROXY })
        expect(proxiedHref(options.agent)).toBe(`${PROXY}/`)
    })

    it('returns no agent for direct targets', () => {
        expect(socketIoProxyOptions('https://hub.example.com', {})).toEqual({})
        expect(socketIoProxyOptions('http://localhost:3006', { HTTPS_PROXY: PROXY })).toEqual({})
        expect(socketIoProxyOptions('https://hub.example.com', { HTTPS_PROXY: PROXY, NO_PROXY: 'hub.example.com' })).toEqual({})
    })
})

describe('axiosEgressConfig', () => {
    beforeEach(() => {
        clearProxyAgentCache()
    })

    it('disables axios env proxy handling and injects our agent when proxied', () => {
        const https = axiosEgressConfig('https://hub.example.com/cli/sessions', { HTTPS_PROXY: PROXY })
        expect(https.proxy).toBe(false)
        expect(proxiedHref(https.httpsAgent)).toBe(`${PROXY}/`)
        expect(https.httpAgent).toBeUndefined()

        const http = axiosEgressConfig('http://hub.example.com/cli/sessions', { HTTP_PROXY: PROXY })
        expect(http.proxy).toBe(false)
        expect(proxiedHref(http.httpAgent)).toBe(`${PROXY}/`)
        expect(http.httpsAgent).toBeUndefined()
    })

    it('forces direct when the resolver bypasses the target', () => {
        const config = axiosEgressConfig('https://10.1.2.3/api', {
            HTTPS_PROXY: PROXY,
            NO_PROXY: '10.0.0.0/8'
        })
        expect(config).toEqual({ proxy: false })
    })
})

describe('proxyAwareAxiosInterceptor', () => {
    beforeEach(() => {
        clearProxyAgentCache()
    })

    it('resolves relative urls against baseURL', () => {
        const interceptor = proxyAwareAxiosInterceptor({ HTTPS_PROXY: PROXY })
        const config = interceptor({
            url: '/api/sessions',
            baseURL: 'https://hub.example.com',
            headers: new AxiosHeaders()
        })
        expect(config.proxy).toBe(false)
        expect(proxiedHref(config.httpsAgent)).toBe(`${PROXY}/`)
    })

    it('leaves unparseable configs untouched', () => {
        const interceptor = proxyAwareAxiosInterceptor({ HTTPS_PROXY: PROXY })
        const config = { url: '', headers: new AxiosHeaders() }
        expect(interceptor(config)).toEqual(config)
    })
})
