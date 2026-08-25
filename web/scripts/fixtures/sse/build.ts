import { SessionPatchSchema, SessionSchema } from '@hapi/protocol/schemas'
import type { Session, SessionPatch } from '@/types/api'
import { FIXTURE_VERSION } from '../fixtureTypes'
import { toCanonicalJson } from '../serialize'
import { runSessionPatchScript } from './apply'
import type { SseFixtureCase, SseFixtureDocument } from './types'

/** Parse `value` with `schema` and require the stored (parsed) form to be a
 *  fixed point of the schema: parsing it again must be byte-identical. This
 *  guarantees natives can decode the document verbatim without re-running
 *  zod defaults/transforms, and that authored inputs cannot drift from the
 *  wire schema. */
function parseToNormalForm<T>(
    schema: { parse: (input: unknown) => T },
    value: unknown,
    label: string
): T {
    const parsed = schema.parse(JSON.parse(toCanonicalJson(value)))
    const reparsed = schema.parse(JSON.parse(toCanonicalJson(parsed)))
    if (toCanonicalJson(reparsed) !== toCanonicalJson(parsed)) {
        throw new Error(`${label} is not schema-normalized: author it in parsed form`)
    }
    return JSON.parse(toCanonicalJson(parsed)) as T
}

export function buildSseFixtureDocument(fixtureCase: SseFixtureCase): SseFixtureDocument {
    const initialSession = parseToNormalForm<Session>(
        SessionSchema,
        fixtureCase.initialSession,
        `${fixtureCase.name}: initialSession`
    )
    const patches = fixtureCase.patches.map((patch, index) => {
        const parsed = parseToNormalForm<SessionPatch>(
            SessionPatchSchema,
            patch,
            `${fixtureCase.name}: patches[${index}]`
        )
        if (Object.keys(parsed).length === 0) {
            throw new Error(`${fixtureCase.name}: patches[${index}] is empty`)
        }
        return parsed
    })
    const { expectedPatchResults, expectedSession } = runSessionPatchScript(initialSession, patches)
    // Patch application must never produce a schema-invalid session.
    SessionSchema.parse(JSON.parse(toCanonicalJson(expectedSession)))
    return {
        fixtureVersion: FIXTURE_VERSION,
        name: fixtureCase.name,
        description: fixtureCase.description,
        initialSession,
        patches,
        expectedPatchResults,
        expectedSession: JSON.parse(toCanonicalJson(expectedSession)) as Session
    }
}
