import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { stat } from 'node:fs/promises'

import {
    PREVIEW_REGISTER_ACK_TIMEOUT_MS,
    isLoopbackTarget,
    type PreviewFrame,
    type PreviewMountDescriptor,
    type PreviewOpenFrame,
    type PreviewRegisterAck,
    type PreviewUnregisterRequest
} from '@hapi/protocol/preview'

import { logger } from '@/ui/logger'

import type { PreviewConnHandlers, PreviewConnSink } from './tunnelClient'

/**
 * CLI-owned preview mount table. The manager mints mountIds, registers mounts
 * on the hub (which builds the public URL — only the hub knows
 * HAPI_PUBLIC_URL), and re-registers every live mount with the SAME mountId on
 * reconnect so capability URLs survive hub restarts.
 */

export interface PreviewMount {
    mountId: string
    kind: 'static' | 'proxy'
    name: string
    rootPath?: string
    port?: number
    url?: string
    ws: boolean
    token?: string
    /** Public capability URL returned by the hub. */
    publicUrl: string
    expiresAt: number
    createdAt: number
}

export type PreviewTerminatorFactory = (mount: PreviewMount) => (frame: PreviewOpenFrame, sink: PreviewConnSink) => PreviewConnHandlers | void

/** Narrow socket surface — implemented by an ApiSessionClient adapter. */
export interface PreviewSocketAdapter {
    connected(): boolean
    emitFrame(frame: PreviewFrame): boolean
    register(descriptor: PreviewMountDescriptor): Promise<PreviewRegisterAck | null>
    unregister(request: PreviewUnregisterRequest): Promise<{ ok: boolean } | null>
}

export interface MountStaticArgs {
    path: string
    name?: string
    ttlHours?: number
}

export interface MountProxyArgs {
    port?: number
    url?: string
    name?: string
    ttlHours?: number
    ws?: boolean
}

export interface StopArgs {
    name?: string
    mountId?: string
    all?: boolean
}

function sanitizeName(raw: string, fallback: string): string {
    const cleaned = raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^[-._]+/, '')
        .slice(0, 64)
    return /^[a-z0-9]/.test(cleaned) ? cleaned : fallback
}

export class PreviewMountManager {
    /** Keyed by name — the tool-facing handle. */
    private readonly mounts = new Map<string, PreviewMount>()

    constructor(private readonly socket: PreviewSocketAdapter) {}

    get size(): number {
        return this.mounts.size
    }

    list(): PreviewMount[] {
        return [...this.mounts.values()]
    }

    getByMountId(mountId: string): PreviewMount | undefined {
        for (const mount of this.mounts.values()) {
            if (mount.mountId === mountId) return mount
        }
        return undefined
    }

    get(name: string): PreviewMount | undefined {
        return this.mounts.get(name)
    }

    async mountStatic(args: MountStaticArgs): Promise<PreviewMount> {
        const rootPath = args.path?.trim()
        if (!rootPath || !isAbsolute(rootPath)) {
            throw new Error('path must be an absolute directory')
        }
        const stats = await stat(rootPath).catch(() => null)
        if (!stats?.isDirectory()) {
            throw new Error(`not a directory: ${rootPath}`)
        }
        const name = sanitizeName(args.name ?? rootPath.split(/[\\/]/).filter(Boolean).pop() ?? 'static', 'static')
        const existing = this.mounts.get(name)
        if (existing?.kind === 'static' && existing.rootPath === rootPath) {
            // Same target under the same name → refresh TTL, keep the URL.
            return this.refresh(existing, args.ttlHours)
        }
        const descriptor: PreviewMountDescriptor = {
            mountId: randomUUID(),
            kind: 'static',
            name,
            rootPath,
            ttlSeconds: this.ttlSeconds(args.ttlHours)
        }
        return this.registerNew(descriptor, existing)
    }

    async mountProxy(args: MountProxyArgs): Promise<PreviewMount> {
        if ((args.port !== undefined) === (args.url !== undefined)) {
            throw new Error('specify exactly one of port/url')
        }
        let targetUrl: URL | undefined
        if (args.url !== undefined) {
            try {
                targetUrl = new URL(args.url)
            } catch {
                throw new Error(`invalid url: ${args.url}`)
            }
            if (!isLoopbackTarget(targetUrl)) {
                throw new Error('proxy targets must be loopback (127.0.0.1 / localhost / [::1])')
            }
        }
        const name = sanitizeName(args.name ?? (args.port !== undefined ? `port-${args.port}` : `port-${targetUrl?.port}`), 'proxy')
        const existing = this.mounts.get(name)
        const sameTarget = existing?.kind === 'proxy'
            && (args.port !== undefined
                ? existing.port === args.port
                : existing.url === args.url)
        if (sameTarget && existing) {
            return this.refresh(existing, args.ttlHours)
        }
        const descriptor: PreviewMountDescriptor = {
            mountId: randomUUID(),
            kind: 'proxy',
            name,
            ...(args.port !== undefined ? { port: args.port } : { url: args.url! }),
            ws: args.ws ?? true,
            ttlSeconds: this.ttlSeconds(args.ttlHours)
        }
        return this.registerNew(descriptor, existing)
    }

    /** Unmounts by selector; returns how many mounts were removed. */
    async stop(args: StopArgs): Promise<number> {
        const targets: PreviewMount[] = []
        if (args.all) {
            targets.push(...this.mounts.values())
        } else if (args.name) {
            const mount = this.mounts.get(args.name)
            if (mount) targets.push(mount)
        } else if (args.mountId) {
            const mount = this.getByMountId(args.mountId)
            if (mount) targets.push(mount)
        } else {
            throw new Error('specify one of name/mountId/all')
        }
        if (targets.length === 0) return 0

        const request: PreviewUnregisterRequest = args.all
            ? { all: true }
            : args.name
                ? { name: args.name }
                : { mountId: args.mountId! }
        const ack = await this.socket.unregister(request)
        if (!ack?.ok) {
            throw new Error('hub rejected the unmount request')
        }
        for (const mount of targets) {
            this.mounts.delete(mount.name)
        }
        return targets.length
    }

    /** Re-registers every live mount (same mountIds) after a (re)connect. */
    async reregisterAll(): Promise<void> {
        for (const mount of [...this.mounts.values()]) {
            // Expired mounts must NOT be republished: that would silently
            // revive a URL whose TTL the user already saw lapse, without a
            // new tool call or approval.
            if (mount.expiresAt <= Date.now()) {
                this.mounts.delete(mount.name)
                continue
            }
            try {
                const ack = await this.registerDescriptor(this.descriptorOf(mount))
                if (ack?.ok) {
                    mount.publicUrl = ack.url
                    mount.expiresAt = ack.expiresAt
                }
            } catch (error) {
                logger.debug('[preview] Re-register failed (will retry on next connect):', error instanceof Error ? error.message : String(error))
            }
        }
    }

    /** Called when the socket drops: mounts stay, URLs keep working once back. */
    onDisconnect(): void {}

    private ttlSeconds(ttlHours: number | undefined): number | undefined {
        if (ttlHours === undefined) return undefined
        return Math.max(30, Math.min(Math.round(ttlHours * 3600), 7 * 24 * 3600))
    }

    private descriptorOf(mount: PreviewMount): PreviewMountDescriptor {
        return {
            mountId: mount.mountId,
            kind: mount.kind,
            name: mount.name,
            ...(mount.kind === 'static' ? { rootPath: mount.rootPath! } : mount.port !== undefined ? { port: mount.port } : { url: mount.url! }),
            ws: mount.ws,
            ...(mount.token ? { token: mount.token } : {}),
            ttlSeconds: Math.max(30, Math.min(Math.round((mount.expiresAt - Date.now()) / 1000), 7 * 24 * 3600))
        }
    }

    private async refresh(mount: PreviewMount, ttlHours: number | undefined): Promise<PreviewMount> {
        const descriptor = this.descriptorOf(mount)
        if (ttlHours !== undefined) {
            descriptor.ttlSeconds = this.ttlSeconds(ttlHours)
        }
        const ack = await this.registerDescriptor(descriptor)
        if (!ack?.ok) {
            throw new Error(this.ackError(ack))
        }
        mount.publicUrl = ack.url
        mount.expiresAt = ack.expiresAt
        return mount
    }

    private async registerNew(descriptor: PreviewMountDescriptor, replaced?: PreviewMount): Promise<PreviewMount> {
        const ack = await this.registerDescriptor(descriptor)
        if (!ack?.ok) {
            throw new Error(this.ackError(ack))
        }
        if (replaced) {
            this.mounts.delete(replaced.name)
        }
        const mount: PreviewMount = {
            mountId: descriptor.mountId,
            kind: descriptor.kind,
            name: descriptor.name,
            rootPath: descriptor.rootPath,
            port: descriptor.port,
            url: descriptor.url,
            ws: descriptor.ws ?? true,
            token: descriptor.token,
            publicUrl: ack.url,
            expiresAt: ack.expiresAt,
            createdAt: Date.now()
        }
        this.mounts.set(mount.name, mount)
        return mount
    }

    private registerDescriptor(descriptor: PreviewMountDescriptor): Promise<PreviewRegisterAck | null> {
        if (!this.socket.connected()) {
            return Promise.resolve({ ok: false, error: 'hub socket is not connected', code: 'unknown' })
        }
        return this.socket.register(descriptor)
    }

    private ackError(ack: PreviewRegisterAck | null): string {
        if (!ack) {
            return `preview registration timed out after ${PREVIEW_REGISTER_ACK_TIMEOUT_MS / 1000}s`
        }
        if (!ack.ok) {
            if (ack.code === 'cap') return 'mount limit reached — unmount an existing preview first'
            return ack.error
        }
        return 'unexpected register ack'
    }
}
