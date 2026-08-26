import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionPatchSchema, SessionSchema } from '@hapi/protocol/schemas'
import { FIXTURE_VERSION } from '../../scripts/fixtures/fixtureTypes'
import { toCanonicalJson } from '../../scripts/fixtures/serialize'
import { runSessionPatchScript } from '../../scripts/fixtures/sse/apply'
import type { SseFixtureDocument } from '../../scripts/fixtures/sse/types'

// Self-conformance for the SSE session-patch fixtures in shared/fixtures/sse:
// the stored expectations must equal a fresh applySessionDetailPatch fold over
// the stored initialSession + patches, every input must round-trip through the
// wire schemas unchanged, and every file must be canonically serialized. A
// failure here means the web patch rules (or the schemas) drifted — rerun
// `bun run gen:fixtures` from the repo root and commit the diff, which is what
// flips the native iOS/Android conformance suites red.

const fixturesDir = resolve(process.cwd(), '../shared/fixtures')
const sseDir = join(fixturesDir, 'sse')
const fixtureFiles = readdirSync(sseDir).filter((name) => name.endsWith('.json')).sort()

function canonical(value: unknown): unknown {
    return JSON.parse(toCanonicalJson(value))
}

describe('shared/fixtures/sse golden fixtures', () => {
    it('has generated fixtures on disk', () => {
        expect(fixtureFiles.length).toBeGreaterThan(0)
    })

    it('VERSION matches the generator fixtureVersion', () => {
        expect(readFileSync(join(fixturesDir, 'VERSION'), 'utf8')).toBe(`${FIXTURE_VERSION}\n`)
    })

    for (const file of fixtureFiles) {
        describe(file, () => {
            const raw = readFileSync(join(sseDir, file), 'utf8')
            const document = JSON.parse(raw) as SseFixtureDocument

            it('is canonically serialized (sorted keys, 4-space indent, trailing LF)', () => {
                expect(toCanonicalJson(document)).toBe(raw)
            })

            it('carries the current fixtureVersion and a name matching its file', () => {
                expect(document.fixtureVersion).toBe(FIXTURE_VERSION)
                expect(`${document.name}.json`).toBe(file)
            })

            it('stores schema-normalized wire inputs (SessionSchema / strict SessionPatchSchema)', () => {
                // Parsing the stored form must be a no-op: natives can decode
                // the document verbatim, and a wire-schema change that would
                // alter parsing shows up as a diff here.
                expect(canonical(SessionSchema.parse(document.initialSession)))
                    .toEqual(canonical(document.initialSession))
                expect(document.patches.length).toBeGreaterThan(0)
                for (const patch of document.patches) {
                    expect(canonical(SessionPatchSchema.parse(patch))).toEqual(canonical(patch))
                }
            })

            it('expected outcome matches a fresh applySessionDetailPatch fold over the inputs', () => {
                const { expectedPatchResults, expectedSession } = runSessionPatchScript(
                    document.initialSession,
                    document.patches
                )
                expect(expectedPatchResults).toEqual(document.expectedPatchResults)
                expect(canonical(expectedSession)).toEqual(canonical(document.expectedSession))
            })
        })
    }
})
