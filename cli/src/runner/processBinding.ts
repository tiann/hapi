import type { ProcessStopSignalPhase } from '../utils/windowsProcessStop';

/** Capture all PID bindings before an asynchronous lifecycle operation. */
export function captureProcessBinding(readBinding: () => readonly unknown[]): () => boolean {
    const original = readBinding();
    return () => {
        const current = readBinding();
        return current.length === original.length && current.every((value, index) => value === original[index]);
    };
}

/** Confirming the already-requested session does not replace a stop target. */
export function stopConfirmationBinding(requested: string | undefined, confirmed: string | undefined, target: string): string | undefined {
    return requested === target && confirmed === target ? undefined : confirmed;
}

/** The live child may gain its first record when startup confirms the target. */
export function captureStopResumeRecordBinding<T extends {
    pid: number; requestedSessionId: string; confirmedSessionId?: string; processStartMarker: string;
}>(pid: number, target: string, readChild: () => object | undefined, readRecord: () => T | undefined): () => T | undefined {
    const child = readChild();
    const original = readRecord();
    return () => {
        const record = readRecord();
        // On Windows the tree helper independently verifies the root process
        // marker before it signals; unchanged ChildProcess ownership is also
        // required here. Persisted-only/adopted records never get this bypass.
        if (!original && child && child === readChild() && record?.pid === pid
            && record.requestedSessionId === target && record.confirmedSessionId === target && record.processStartMarker) {
            return undefined;
        }
        return record;
    };
}

/** Protect bindings installed after a stop began, even if a PID was reused. */
export function captureNewProcessBindingGuard<T>(bindings: ReadonlyMap<number, T>): (pid: number) => boolean {
    const original = new Map(bindings);
    return pid => bindings.has(pid) && bindings.get(pid) !== original.get(pid);
}

/** Binding changes usually veto stop. Windows can independently prove a single original child. */
export function captureStopSignalBinding(
    readBinding: () => readonly unknown[],
    hasOtherRoots: () => boolean,
): (phase?: ProcessStopSignalPhase) => boolean {
    const unchanged = captureProcessBinding(readBinding);
    return phase => !hasOtherRoots() && (unchanged() || phase === 'verified-rebound-descendant'
        || (phase === 'descendant' && readBinding().every(value => value === undefined)));
}

/** Archiving the target root is expected; a different root must keep its PID. */
export function sharedStopBinding(session: { sharedSessions?: Record<string, unknown> } | undefined, sessionId: string): string {
    return JSON.stringify(Object.keys(session?.sharedSessions ?? {}).filter(id => id !== sessionId).sort());
}

/** The original generation may stop successfully after its PID was rebound. */
export async function terminateCapturedBinding(
    unchanged: () => boolean,
    terminate: () => Promise<boolean>,
    cleanup: () => void,
): Promise<'stopped' | 'still_alive' | 'unknown'> {
    if (!unchanged()) return 'unknown';
    if (!await terminate()) return 'still_alive';
    if (unchanged()) cleanup();
    return 'stopped';
}
