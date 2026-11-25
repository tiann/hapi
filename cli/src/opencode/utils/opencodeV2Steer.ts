import { createHash } from 'node:crypto';
import { isObject } from '@hapi/protocol';
import type { FetchLike } from './opencodeCompactBridge';

export type OpencodeSteerCancelResult = boolean | 'in-flight' | 'indeterminate' | 'consumed';
export type OpencodeSteerCancelHandler = (localId: string) => Promise<OpencodeSteerCancelResult> | undefined;

type InputContext = {
    baseUrl: string;
    password: string;
    sessionId: string;
    inputId: string;
    text?: string;
    fetchImpl?: FetchLike;
};

export type OpencodeV2InputState = 'pending' | 'delivered' | 'missing' | 'unknown';
export type OpencodeV2Admission = 'admitted' | 'rejected' | 'unknown';
export type OpencodeV2Cancellation = 'cancelled' | 'delivered' | 'unknown';

/** Preserve one native identity across response loss/retry without matching text receipts. */
export function opencodeV2InputId(scope: {
    hapiSessionId: string;
    sessionId: string;
    localId: string;
    text: string;
}): string {
    return 'msg_' + createHash('sha256').update(JSON.stringify([
        scope.hapiSessionId, scope.sessionId, scope.localId, scope.text
    ])).digest('hex');
}

function sessionUrl(opts: InputContext): string {
    return `${opts.baseUrl}/api/session/${encodeURIComponent(opts.sessionId)}`;
}

function request(opts: InputContext, url: string, init?: RequestInit): Promise<Response> {
    return (opts.fetchImpl ?? fetch)(url, {
        ...init,
        headers: {
            authorization: 'Basic ' + Buffer.from(`opencode:${opts.password}`).toString('base64'),
            'content-type': 'application/json'
        },
        // Bound only HTTP admission/readback, never model execution. This is
        // the native transcript's existing read budget, below the hub RPC budget.
        signal: AbortSignal.timeout(10_000)
    });
}

function matchesUser(value: unknown, opts: InputContext, inbox: boolean): boolean {
    if (!isObject(value) || value.id !== opts.inputId || value.sessionID !== opts.sessionId || value.type !== 'user') return false;
    const text = inbox && isObject(value.payload) ? value.payload.text : value.text;
    return typeof text === 'string' && (opts.text === undefined || text === opts.text);
}

/** OpenCode's experimental v2 API: admission is durable, but is not delivery. */
export async function admitOpencodeV2Steer(opts: InputContext & { text: string }): Promise<OpencodeV2Admission> {
    try {
        const response = await request(opts, `${sessionUrl(opts)}/prompt`, {
            method: 'POST',
            body: JSON.stringify({ id: opts.inputId, text: opts.text, delivery: 'steer' })
        });
        if ([400, 401, 403, 404, 422].includes(response.status)) return 'rejected';
        if (!response.ok) return 'unknown';
        const body: unknown = await response.json();
        if (!isObject(body) || !matchesUser(body.data, opts, true) || !isObject(body.data)) return 'unknown';
        if (body.data.delivery === 'queue') {
            // A retry may find the same durable identity parked by the native
            // client. Change its mode; a second POST must not create a copy.
            const changed = await request(opts, `${sessionUrl(opts)}/inbox/${encodeURIComponent(opts.inputId)}`, {
                method: 'PATCH', body: JSON.stringify({ delivery: 'steer' })
            });
            // It may have been delivered before PATCH. Let exact readback
            // settle that race rather than classifying a conflict as rejection.
            if (!changed.ok && changed.status !== 409) return 'unknown';
        } else if (body.data.delivery !== 'steer') return 'unknown';
        return 'admitted';
    } catch {
        return 'unknown';
    }
}

/** Read inbox BEFORE projection: an absent pending item can already be delivered. */
export async function readOpencodeV2Input(opts: InputContext): Promise<OpencodeV2InputState> {
    try {
        const inboxResponse = await request(opts, `${sessionUrl(opts)}/inbox`);
        if (!inboxResponse.ok) return 'unknown';
        const inbox: unknown = await inboxResponse.json();
        if (!isObject(inbox) || !Array.isArray(inbox.data)) return 'unknown';
        for (const value of inbox.data) {
            if (!isObject(value) || typeof value.id !== 'string' || value.sessionID !== opts.sessionId) return 'unknown';
            if (value.id === opts.inputId) return matchesUser(value, opts, true) ? 'pending' : 'unknown';
        }
        const projection = await request(opts, `${sessionUrl(opts)}/message/${encodeURIComponent(opts.inputId)}`);
        if (projection.status === 404) return 'missing';
        if (!projection.ok) return 'unknown';
        const body: unknown = await projection.json();
        return isObject(body) && matchesUser(body.data, opts, false) ? 'delivered' : 'unknown';
    } catch {
        return 'unknown';
    }
}

/** Caller must first know its admission POST settled; DELETE204 alone is a no-op too. */
export async function cancelOpencodeV2Steer(opts: InputContext): Promise<OpencodeV2Cancellation> {
    try {
        const response = await request(opts, `${sessionUrl(opts)}/inbox/${encodeURIComponent(opts.inputId)}`, { method: 'DELETE' });
        if (!response.ok) return 'unknown';
        const state = await readOpencodeV2Input(opts);
        if (state === 'delivered') return 'delivered';
        return state === 'missing' ? 'cancelled' : 'unknown';
    } catch {
        return 'unknown';
    }
}

/** Re-steer a positively identified existing inbox entry without resubmitting uncertain input. */
export async function steerOpencodeV2Inbox(opts: InputContext): Promise<OpencodeV2Admission> {
    try {
        const response = await request(opts, `${sessionUrl(opts)}/inbox/${encodeURIComponent(opts.inputId)}`, {
            method: 'PATCH', body: JSON.stringify({ delivery: 'steer' })
        });
        return response.ok || response.status === 409 ? 'admitted' : 'unknown';
    } catch {
        return 'unknown';
    }
}
