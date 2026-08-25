import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearMessageWindow } from '@/lib/message-window-store'
import { FIXTURE_VERSION } from '../../scripts/fixtures/fixtureTypes'
import {
    extractOpExpectations,
    paginationFixtureSessionId,
    runPaginationScript
} from '../../scripts/fixtures/pagination/runner'
import type { PaginationFixtureDocument } from '../../scripts/fixtures/pagination/types'
import { toCanonicalJson } from '../../scripts/fixtures/serialize'

// Self-conformance for the pagination fixtures in shared/fixtures/pagination:
// replaying every stored op script through the REAL message-window store must
// reproduce the stored request log, older-load outcomes, reconcile candidates
// and final window projection, and every file must be canonically serialized.
// A failure here means the web store (or the projection) drifted — rerun
// `bun run gen:fixtures` from the repo root and commit the diff, which is what
// flips the native iOS/Android conformance suites red.

const fixturesDir = resolve(process.cwd(), '../shared/fixtures')
const paginationDir = join(fixturesDir, 'pagination')
const fixtureFiles = readdirSync(paginationDir).filter((name) => name.endsWith('.json')).sort()

function canonical(value: unknown): unknown {
    return JSON.parse(toCanonicalJson(value))
}

afterEach(() => {
    for (const file of fixtureFiles) {
        clearMessageWindow(paginationFixtureSessionId(file.slice(0, -'.json'.length)))
    }
    sessionStorage.clear()
})

describe('shared/fixtures/pagination golden fixtures', () => {
    it('has generated fixtures on disk', () => {
        expect(fixtureFiles.length).toBeGreaterThan(0)
    })

    it('VERSION matches the generator fixtureVersion', () => {
        expect(readFileSync(join(fixturesDir, 'VERSION'), 'utf8')).toBe(`${FIXTURE_VERSION}\n`)
    })

    for (const file of fixtureFiles) {
        describe(file, () => {
            const raw = readFileSync(join(paginationDir, file), 'utf8')
            const document = JSON.parse(raw) as PaginationFixtureDocument

            it('is canonically serialized (sorted keys, 4-space indent, trailing LF)', () => {
                expect(toCanonicalJson(document)).toBe(raw)
            })

            it('carries the current fixtureVersion and a name matching its file', () => {
                expect(document.fixtureVersion).toBe(FIXTURE_VERSION)
                expect(`${document.name}.json`).toBe(file)
            })

            it('replaying the ops against the real store matches the stored expectations', async () => {
                const { observations, expectedState } = await runPaginationScript(
                    paginationFixtureSessionId(document.name),
                    document.ops
                )
                expect(canonical(observations)).toEqual(canonical(extractOpExpectations(document.ops)))
                expect(canonical(expectedState)).toEqual(canonical(document.expectedState))
            })
        })
    }
})
