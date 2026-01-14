import { isIP } from 'node:net'
import { connect, type PeerCertificate } from 'node:tls'
import type { TunnelManager } from './tunnelManager'

type SubjectAltName = {
    type: 'DNS' | 'IP'
    value: string
}

function parseSubjectAltNames(value: string | undefined): SubjectAltName[] {
    if (!value) {
        return []
    }

    return value
        .split(',')
        .map(entry => entry.trim())
        .map(entry => {
            const match = entry.match(/^(DNS|IP Address):\s*(.+)$/i)
            if (!match) {
                return null
            }
            const nameType = match[1].toLowerCase() === 'dns' ? 'DNS' : 'IP'
            return { type: nameType, value: match[2].trim() }
        })
        .filter((entry): entry is SubjectAltName => Boolean(entry?.value))
}

function dnsNameMatchesHost(host: string, dnsName: string): boolean {
    const normalizedHost = host.toLowerCase()
    const normalizedDns = dnsName.toLowerCase()

    if (normalizedDns === normalizedHost) {
        return true
    }

    if (!normalizedDns.startsWith('*.')) {
        return false
    }

    const suffix = normalizedDns.slice(2)
    if (!normalizedHost.endsWith(`.${suffix}`)) {
        return false
    }

    const remainder = normalizedHost.slice(0, normalizedHost.length - suffix.length - 1)
    return remainder.length > 0 && !remainder.includes('.')
}

function hostMatchesCertificate(host: string, cert: PeerCertificate): boolean {
    const altNames = parseSubjectAltNames(cert.subjectaltname)
    const hostIsIp = isIP(host) !== 0

    if (altNames.length > 0) {
        if (hostIsIp) {
            return altNames.some(name => name.type === 'IP' && name.value === host)
        }
        return altNames.some(name => name.type === 'DNS' && dnsNameMatchesHost(host, name.value))
    }

    const commonName = cert.subject?.CN
    if (!commonName) {
        return false
    }

    if (hostIsIp) {
        return commonName === host
    }

    return dnsNameMatchesHost(host, commonName)
}

function parseCertDate(value: string | undefined): Date | null {
    if (!value) {
        return null
    }

    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
}

function isCertificateTimeValid(cert: PeerCertificate): boolean {
    const validFrom = parseCertDate(cert.valid_from)
    const validTo = parseCertDate(cert.valid_to)

    if (!validFrom || !validTo) {
        return false
    }

    const now = Date.now()
    const skewMs = 5 * 60 * 1000

    if (validFrom.getTime() - skewMs > now) {
        return false
    }

    if (validTo.getTime() + skewMs < now) {
        return false
    }

    return true
}

function isValidTunnelCertificate(host: string, cert: PeerCertificate): boolean {
    if (!isCertificateTimeValid(cert)) {
        return false
    }

    if (!hostMatchesCertificate(host, cert)) {
        return false
    }

    return true
}

async function checkTunnelCertificate(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return await new Promise(resolve => {
        let resolved = false
        const servername = isIP(host) === 0 ? host : undefined
        const socket = connect({
            host,
            port,
            servername,
            rejectUnauthorized: false
        })

        const finalize = (result: boolean) => {
            if (resolved) {
                return
            }
            resolved = true
            socket.destroy()
            resolve(result)
        }

        const timer = setTimeout(() => finalize(false), timeoutMs)

        socket.once('error', () => {
            clearTimeout(timer)
            finalize(false)
        })

        socket.once('secureConnect', () => {
            clearTimeout(timer)
            if (!socket.authorized) {
                finalize(false)
                return
            }
            const cert = socket.getPeerCertificate()
            if (!cert || Object.keys(cert).length === 0) {
                finalize(false)
                return
            }
            finalize(isValidTunnelCertificate(host, cert))
        })
    })
}

export async function waitForTunnelTlsReady(tunnelUrl: string, tunnelManager: TunnelManager): Promise<boolean> {
    let host: string | null = null
    let port = 443

    try {
        const parsedUrl = new URL(tunnelUrl)
        if (parsedUrl.protocol !== 'https:') {
            return true
        }
        host = parsedUrl.hostname
        if (parsedUrl.port) {
            const parsedPort = Number.parseInt(parsedUrl.port, 10)
            if (Number.isFinite(parsedPort)) {
                port = parsedPort
            }
        }
    } catch {
        return true
    }

    if (!host) {
        return true
    }

    const pollIntervalMs = 1500
    const requestTimeoutMs = 2500
    const logIntervalMs = 15000
    let lastLogAt = 0

    while (tunnelManager.isConnected()) {
        if (await checkTunnelCertificate(host, port, requestTimeoutMs)) {
            return true
        }

        const now = Date.now()
        if (now - lastLogAt >= logIntervalMs) {
            console.log('[Tunnel] Waiting for trusted TLS certificate...')
            lastLogAt = now
        }

        await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }

    return false
}
