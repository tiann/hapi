import type { TelemetryBatch } from '@hapi/protocol/telemetry'
import { buildTelemetryHeaders, resolveBearerToken, telemetryUrl } from './negotiate'

/**
 * Uplink: POST /api/telemetry/events (ruling 2: keepalive fetch is the ONLY
 * channel — sendBeacon cannot carry Authorization and a token-in-query would
 * land in openresty/CF access logs).
 *
 * The SDK deliberately calls the raw global fetch, NOT the authProxy wrapper:
 * that would route the uplink through its own observation (self-excitation
 * loop, design §7.2 risk 9). The self-header belt-and-suspenders any wrapped
 * path as well.
 */

export async function postTelemetryBatch(batch: TelemetryBatch, keepalive: boolean): Promise<Response> {
    return await fetch(telemetryUrl('/api/telemetry/events'), {
        method: 'POST',
        headers: buildTelemetryHeaders(resolveBearerToken()),
        body: JSON.stringify(batch),
        keepalive,
    })
}
