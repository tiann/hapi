/** Capture all PID bindings before an asynchronous lifecycle operation. */
export function captureProcessBinding(readBinding: () => readonly unknown[]): () => boolean {
    const original = readBinding();
    return () => {
        const current = readBinding();
        return current.length === original.length && current.every((value, index) => value === original[index]);
    };
}

/** Empty maps after a proven wrapper exit are expected, unlike replacement bindings. */
export function captureStopSignalBinding(
    readBinding: () => readonly unknown[],
    hasOtherRoots: () => boolean,
): (phase?: 'root' | 'descendant') => boolean {
    const unchanged = captureProcessBinding(readBinding);
    return phase => !hasOtherRoots() && (unchanged()
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
