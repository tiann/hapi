import type { ExecutionControl } from '@hapi/protocol/types'

export function initializeDesktopMirrorControl(now: number): ExecutionControl {
    return {
        owner: 'desktop-sync',
        generation: 1,
        leaseExpiresAt: null,
        runnerSessionId: null,
        updatedAt: now
    }
}

export function acquireRunnerControl(
    current: ExecutionControl | null,
    runnerSessionId: string,
    now: number,
    leaseMs: number
): ExecutionControl {
    const generation = (current?.generation ?? 0) + 1
    return {
        owner: 'hapi-runner',
        generation,
        leaseExpiresAt: now + leaseMs,
        runnerSessionId,
        updatedAt: now
    }
}

export function releaseRunnerControl(current: ExecutionControl | null, now: number): ExecutionControl {
    return {
        owner: 'desktop-sync',
        generation: (current?.generation ?? 0) + 1,
        leaseExpiresAt: null,
        runnerSessionId: null,
        updatedAt: now
    }
}

export function shouldAcceptPassiveSync(
    current: ExecutionControl | null,
    generation: number | undefined,
    now: number
): { accepted: boolean; nextControl: ExecutionControl | null } {
    if (!current) {
        return { accepted: true, nextControl: initializeDesktopMirrorControl(now) }
    }
    if (generation !== undefined && generation !== current.generation) {
        return { accepted: false, nextControl: current }
    }
    if (current.owner === 'hapi-runner' && current.leaseExpiresAt && current.leaseExpiresAt > now) {
        return { accepted: true, nextControl: current }
    }
    return { accepted: true, nextControl: current.owner === 'desktop-sync' ? current : releaseRunnerControl(current, now) }
}
