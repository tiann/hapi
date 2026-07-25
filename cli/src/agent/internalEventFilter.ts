/**
 * Detect internal session-metadata JSON that leaks into agent text output.
 *
 * Claude's SDK occasionally emits internal control messages as text chunks.
 * The known leaked shape is the session metadata envelope:
 *   { type: "output", data: { parentUuid, sessionId, userType, ... } }
 *
 * We match on the specific structure rather than a broad type allowlist to
 * avoid accidentally suppressing legitimate assistant JSON.
 *
 * Surrounding whitespace is tolerated: the envelope is also checked at the
 * text-flush boundary, where it may have been reassembled from chunks that
 * carried a leading newline or indentation.
 */
export function isInternalEventJson(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed[0] !== '{') return false;

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return false;
    }
    if (typeof parsed !== 'object' || parsed === null) return false;

    const record = parsed as Record<string, unknown>;

    // Match the known leaked metadata envelope:
    // { type: "output", data: { parentUuid, sessionId, userType, ... } }
    if (record.type === 'output' && typeof record.data === 'object' && record.data !== null) {
        const data = record.data as Record<string, unknown>;
        const hasParentUuid = typeof data.parentUuid === 'string' || data.parentUuid === null;
        return hasParentUuid
            && typeof data.sessionId === 'string'
            && typeof data.userType === 'string';
    }

    return false;
}
