/**
 * CLI-side proxy wiring.
 *
 * Resolution lives in @hapi/protocol/net; this module only adapts the result
 * to the shapes expected by socket.io-client and axios.
 */

import axios, { type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios'
import type { ManagerOptions } from 'socket.io-client'
import { createProxyAgent } from '@hapi/protocol/net'

/**
 * Proxy options for socket.io / engine.io-client.
 *
 * engine.io-client forwards `agent` to npm `ws`; WebSocket traffic only uses a
 * proxy when the agent is passed explicitly. engine.io-client types the field
 * as `string | boolean`, but the runtime accepts an http.Agent, so the cast is
 * contained here.
 */
export function socketIoProxyOptions(
    target: string,
    env: NodeJS.ProcessEnv = process.env
): { agent?: ManagerOptions['agent'] } {
    const agent = createProxyAgent(target, env)
    if (!agent) {
        return {}
    }
    return { agent: agent as unknown as ManagerOptions['agent'] }
}

/**
 * Make axios use the shared egress resolution:
 * - proxy resolved: pass our http(s) agent explicitly;
 * - direct: set `proxy: false` to disable axios' own env handling, keeping HTTP
 *   consistent with WebSocket (e.g. CIDR / IPv6 NO_PROXY rules).
 */
export function axiosEgressConfig(target: string, env: NodeJS.ProcessEnv = process.env): AxiosRequestConfig {
    const url = new URL(target)
    const agent = createProxyAgent(url, env)
    if (!agent) {
        return { proxy: false }
    }
    return url.protocol === 'https:'
        ? { proxy: false, httpsAgent: agent }
        : { proxy: false, httpAgent: agent }
}

/** Request interceptor exposed for tests. */
export function proxyAwareAxiosInterceptor(
    env: NodeJS.ProcessEnv = process.env
): (config: InternalAxiosRequestConfig) => InternalAxiosRequestConfig {
    return (config) => {
        const target = resolveAxiosTarget(config)
        if (!target) {
            return config
        }
        const egress = axiosEgressConfig(target.href, env)
        config.proxy = false
        if (egress.httpsAgent) {
            config.httpsAgent = egress.httpsAgent
        }
        if (egress.httpAgent) {
            config.httpAgent = egress.httpAgent
        }
        return config
    }
}

let installed = false

/** Install the global interceptor once at CLI startup, covering all axios calls. */
export function installProxyAwareAxios(env: NodeJS.ProcessEnv = process.env): void {
    if (installed) {
        return
    }
    installed = true
    axios.interceptors.request.use(proxyAwareAxiosInterceptor(env))
}

/** Test helper: allow re-installation. */
export function resetProxyAwareAxiosForTests(): void {
    installed = false
}

function resolveAxiosTarget(config: AxiosRequestConfig | InternalAxiosRequestConfig): URL | null {
    if (!config.url) {
        return null
    }
    try {
        return new URL(config.url, config.baseURL)
    } catch {
        return null
    }
}
