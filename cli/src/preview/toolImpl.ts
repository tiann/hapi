import type { ApiSessionClient } from '@/api/apiSession'

import { PREVIEW_SUBPATH_NOTE } from '@hapi/protocol/preview'

import type { PreviewMount } from './mountManager'

/**
 * Implementations of the preview_* MCP tools. Each returns a text result the
 * model can read (the URL must be model-visible so the agent can share it) and
 * additionally posts a clickable link into the chat on successful mounts.
 */

export interface PreviewToolContent {
    content: { type: 'text'; text: string }[]
    isError?: boolean
}

function textResult(text: string, isError = false): PreviewToolContent {
    return { content: [{ type: 'text', text }], isError: isError || undefined }
}

function formatExpiry(mount: PreviewMount): string {
    try {
        return new Date(mount.expiresAt).toISOString()
    } catch {
        return String(mount.expiresAt)
    }
}

function describeMount(mount: PreviewMount): string {
    const target = mount.kind === 'static'
        ? `Root: ${mount.rootPath} (read-only, files up to 25 MiB, no directory listing, dotfiles rejected)`
        : `Target: ${mount.port !== undefined ? `http://127.0.0.1:${mount.port}` : mount.url}${mount.ws ? ' (WebSocket pass-through on)' : ' (WebSocket pass-through off)'}`
    return [
        `${mount.kind === 'static' ? 'Static' : 'Dev server'} preview mounted.`,
        `URL: ${mount.publicUrl}`,
        `Name: ${mount.name}`,
        `Expires: ${formatExpiry(mount)}`,
        target,
        PREVIEW_SUBPATH_NOTE
    ].join('\n')
}

function postChatLink(client: ApiSessionClient, mount: PreviewMount): void {
    void client.sendAgentMessage({
        type: 'message',
        message: `🔗 Preview ready: ${mount.publicUrl} (expires ${formatExpiry(mount)})`
    })
}

export async function previewStaticTool(client: ApiSessionClient, args: { path?: string; name?: string; ttlHours?: number }): Promise<PreviewToolContent> {
    if (!args.path || !args.path.trim()) {
        return textResult('Error: path is required (absolute directory to expose)', true)
    }
    try {
        const mount = await client.getPreviewRuntime().mounts.mountStatic({
            path: args.path,
            name: args.name,
            ttlHours: args.ttlHours
        })
        postChatLink(client, mount)
        return textResult(describeMount(mount))
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return textResult(`Failed to mount static preview: ${message}`, true)
    }
}

export async function previewProxyTool(client: ApiSessionClient, args: { port?: number; url?: string; name?: string; ttlHours?: number; ws?: boolean }): Promise<PreviewToolContent> {
    if (args.port === undefined && args.url === undefined) {
        return textResult('Error: provide the dev server port (or a loopback url), e.g. {"port": 5173}', true)
    }
    try {
        const mount = await client.getPreviewRuntime().mounts.mountProxy({
            port: args.port,
            url: args.url,
            name: args.name,
            ttlHours: args.ttlHours,
            ws: args.ws
        })
        postChatLink(client, mount)
        return textResult(describeMount(mount))
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return textResult(`Failed to mount proxy preview: ${message}`, true)
    }
}

export async function previewStopTool(client: ApiSessionClient, args: { name?: string; mountId?: string; all?: boolean }): Promise<PreviewToolContent> {
    if (!args.name && !args.mountId && !args.all) {
        return textResult('Error: specify name, mountId, or all=true', true)
    }
    try {
        const stopped = await client.getPreviewRuntime().mounts.stop({
            name: args.name,
            mountId: args.mountId,
            all: args.all
        })
        return textResult(stopped === 0 ? 'No matching preview mounts.' : `Unmounted ${stopped} preview${stopped === 1 ? '' : 's'}. The URL now returns 410 after a short grace period.`)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return textResult(`Failed to unmount preview: ${message}`, true)
    }
}
