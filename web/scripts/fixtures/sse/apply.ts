import { applySessionDetailPatch } from '@/lib/sessionPatch'
import type { Session, SessionPatch } from '@/types/api'
import type { SessionPatchResult } from './types'

/**
 * The exact fold a client must implement for `session-updated` patches on a
 * detail session cache: apply patches in arrival order; a `null` return means
 * "nothing changed, keep the previous object". Shared by the fixture
 * generator and the self-conformance vitest so the two can never diverge.
 */
export function runSessionPatchScript(
    initialSession: Session,
    patches: SessionPatch[]
): { expectedPatchResults: SessionPatchResult[]; expectedSession: Session } {
    let session = initialSession
    const expectedPatchResults: SessionPatchResult[] = []
    for (const patch of patches) {
        const next = applySessionDetailPatch(session, patch)
        expectedPatchResults.push(next === null ? 'unchanged' : 'applied')
        session = next ?? session
    }
    return { expectedPatchResults, expectedSession: session }
}
