/**
 * MCP surface for metadata.waiting (tiann/hapi#2020 / #2616).
 * Own-session only: mark/clear externally blocked work so keepalive-idle
 * reconcile (and destroy-state callers) do not treat a CI/vendor/peer wait
 * as an abandoned socket.
 */

import { z } from 'zod'
import type { Metadata } from '@hapi/protocol/types'

export const SESSION_WAITING_TOOL_NAME = 'session_waiting'

type WaitingMetadataClient = {
    updateMetadata: (
        handler: (metadata: Metadata) => Metadata,
        options?: { signal?: AbortSignal }
    ) => void
    /** Drain pending update-metadata acks (ApiSessionClient.flushMetadata). */
    flushMetadata: (timeoutMs?: number) => Promise<boolean>
    /** Local cache after hub ack (ApiSessionClient.getMetadata). */
    getMetadata: () => Readonly<Metadata> | null
}

export const SESSION_WAITING_TOOL_DESCRIPTION = [
    'Mark THIS HAPI session as waiting on external work (CI, vendor, peer reply)',
    'so the hub does not treat it as a keepalive zombie between polls.',
    'Own-session only. action=set stamps metadata.waiting; action=clear removes it.',
    'Call set when you begin an external wait (e.g. watch CI on tip); call clear when',
    'the wait ends, is cancelled, or you resume turn work. Not for thinking turns,',
    'operator permission prompts, or session_job progress meters.',
].join(' ')

export const sessionWaitingInputSchema: z.ZodTypeAny = z.object({
    action: z.enum(['set', 'clear']).describe(
        'set=stamp waiting (optional reason); clear=remove waiting'
    ),
    reason: z.string().trim().min(1).max(200).optional().describe(
        'Short reason when action=set (e.g. "watch CI on tip")'
    ),
})

export type SessionWaitingToolArgs = {
    action: 'set' | 'clear'
    reason?: string
}

export type SessionWaitingToolResult = {
    text: string
    isError: boolean
}

function waitingIsSet(meta: Readonly<Metadata> | null): boolean {
    const waiting = meta?.waiting
    return waiting != null && typeof waiting === 'object' && typeof (waiting as { since?: unknown }).since === 'number'
}

/**
 * Stamp or clear metadata.waiting via the versioned update-metadata path,
 * then await hub ack before reporting success (#2616 Major).
 */
export async function applySessionWaiting(
    client: WaitingMetadataClient,
    args: SessionWaitingToolArgs,
    options?: { flushTimeoutMs?: number }
): Promise<SessionWaitingToolResult> {
    const flushTimeoutMs = options?.flushTimeoutMs ?? 5_000

    if (args.action === 'clear') {
        client.updateMetadata((meta) => ({ ...meta, waiting: null }))
        const flushed = await client.flushMetadata(flushTimeoutMs)
        if (!flushed) {
            return {
                text: 'session_waiting clear unconfirmed: hub metadata ack timed out',
                isError: true,
            }
        }
        if (waitingIsSet(client.getMetadata())) {
            return {
                text: 'session_waiting clear unconfirmed: hub still has metadata.waiting',
                isError: true,
            }
        }
        return { text: 'Cleared metadata.waiting', isError: false }
    }

    const reason = args.reason?.trim()
    const waiting = {
        since: Date.now(),
        ...(reason ? { reason } : {}),
    }
    client.updateMetadata((meta) => ({ ...meta, waiting }))
    const flushed = await client.flushMetadata(flushTimeoutMs)
    if (!flushed) {
        return {
            text: 'session_waiting set unconfirmed: hub metadata ack timed out',
            isError: true,
        }
    }
    const acked = client.getMetadata()?.waiting
    if (!waitingIsSet(client.getMetadata())) {
        return {
            text: 'session_waiting set unconfirmed: hub metadata.waiting missing after ack',
            isError: true,
        }
    }
    const ackedReason = acked && typeof acked === 'object' && 'reason' in acked
        ? (acked as { reason?: string }).reason
        : undefined
    const since = (acked as { since: number }).since
    return {
        text: ackedReason
            ? `Set metadata.waiting since=${since} reason=${JSON.stringify(ackedReason)}`
            : `Set metadata.waiting since=${since}`,
        isError: false,
    }
}

export async function handleSessionWaitingTool(
    args: SessionWaitingToolArgs,
    client: WaitingMetadataClient
): Promise<SessionWaitingToolResult> {
    try {
        return await applySessionWaiting(client, args)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { text: `session_waiting failed: ${message}`, isError: true }
    }
}
