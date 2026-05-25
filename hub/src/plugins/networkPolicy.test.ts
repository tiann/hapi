import { describe, expect, it } from 'bun:test'
import {
    checkPluginNetworkAccess,
    createPluginNetwork,
    type PluginNetworkDiagnosticSink
} from '@hapi/protocol/plugins/runtime/networkPolicy'

function responseFetch(calls: string[], response: Response = new Response('ok')): typeof fetch {
    return (async (input: Request | string | URL) => {
        const request = input instanceof Request ? input : new Request(input instanceof URL ? input.href : input)
        calls.push(request.url)
        return response
    }) as typeof fetch
}

describe('plugin network policy', () => {
    it('allows declared origins through ctx.network.fetch', async () => {
        const calls: string[] = []
        const network = createPluginNetwork({
            pluginId: 'com.example.net',
            declaredNetwork: ['https://api.example.com'],
            fetchImpl: responseFetch(calls)
        })

        const response = await network.fetch('https://api.example.com/v1/send?token=secret')

        expect(await response.text()).toBe('ok')
        expect(calls).toEqual(['https://api.example.com/v1/send?token=secret'])
    })

    it('blocks undeclared targets without leaking URL paths or query strings into diagnostics', async () => {
        const calls: string[] = []
        const diagnostics: Array<{ severity: string; code: string; message: string }> = []
        const onDiagnostic: PluginNetworkDiagnosticSink = (severity, code, message) => {
            diagnostics.push({ severity, code, message })
        }
        const network = createPluginNetwork({
            pluginId: 'com.example.net',
            declaredNetwork: ['https://api.example.com'],
            fetchImpl: responseFetch(calls),
            onDiagnostic
        })

        await expect(network.fetch('https://evil.example.com/secret-path?token=super-secret')).rejects.toThrow('not declared')

        expect(calls).toEqual([])
        expect(diagnostics).toEqual([{
            severity: 'warning',
            code: 'plugin-network-blocked',
            message: 'Blocked SDK network request to https://evil.example.com: not declared in permissions.network.'
        }])
        expect(JSON.stringify(diagnostics)).not.toContain('secret-path')
        expect(JSON.stringify(diagnostics)).not.toContain('super-secret')
    })

    it('matches wildcard subdomains and path prefixes only within declared scope', () => {
        expect(checkPluginNetworkAccess({
            pluginId: 'com.example.net',
            declaredNetwork: ['https://*.example.com/api/*'],
            inputUrl: 'https://a.example.com/api/send'
        })).toMatchObject({ allowed: true })

        expect(checkPluginNetworkAccess({
            pluginId: 'com.example.net',
            declaredNetwork: ['https://*.example.com/api/*'],
            inputUrl: 'https://example.com/api/send'
        })).toMatchObject({ allowed: false, reason: 'not declared in permissions.network' })

        expect(checkPluginNetworkAccess({
            pluginId: 'com.example.net',
            declaredNetwork: ['https://*.example.com/api/*'],
            inputUrl: 'https://a.example.com/other/send'
        })).toMatchObject({ allowed: false, reason: 'not declared in permissions.network' })
    })

    it('blocks local and private literal network targets even when declared', () => {
        expect(checkPluginNetworkAccess({
            pluginId: 'com.example.net',
            declaredNetwork: ['http://localhost'],
            inputUrl: 'http://localhost/api'
        })).toMatchObject({ allowed: false, reason: 'localhost targets are not allowed' })

        for (const inputUrl of [
            'http://127.0.0.1/api',
            'http://10.0.0.1/api',
            'http://192.168.1.20/api',
            'http://[::1]/api',
            'http://[::ffff:127.0.0.1]/api'
        ]) {
            expect(checkPluginNetworkAccess({
                pluginId: 'com.example.net',
                declaredNetwork: [inputUrl],
                inputUrl
            })).toMatchObject({ allowed: false, reason: 'private or local IP targets are not allowed' })
        }
    })

    it('rejects URL credentials before fetch', async () => {
        const calls: string[] = []
        const network = createPluginNetwork({
            pluginId: 'com.example.net',
            declaredNetwork: ['https://api.example.com'],
            fetchImpl: responseFetch(calls)
        })

        await expect(network.fetch('https://user:pass@api.example.com/send')).rejects.toThrow('URL credentials are not allowed')

        expect(calls).toEqual([])
    })

    it('checks redirect targets before following them', async () => {
        const calls: string[] = []
        const diagnostics: Array<{ severity: string; code: string; message: string }> = []
        const network = createPluginNetwork({
            pluginId: 'com.example.net',
            declaredNetwork: ['https://api.example.com'],
            fetchImpl: responseFetch(calls, new Response('', {
                status: 302,
                headers: { location: 'https://evil.example.com/redirect-secret' }
            })),
            onDiagnostic: (severity, code, message) => diagnostics.push({ severity, code, message })
        })

        await expect(network.fetch('https://api.example.com/start')).rejects.toThrow('redirect blocked')

        expect(calls).toEqual(['https://api.example.com/start'])
        expect(diagnostics.map((entry) => entry.code)).toEqual(['plugin-network-request', 'plugin-network-blocked'])
        expect(JSON.stringify(diagnostics)).not.toContain('redirect-secret')
    })
})
