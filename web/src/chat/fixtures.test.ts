import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIXTURE_VERSION, type FixtureDocument } from '../../scripts/fixtures/fixtureTypes'
import { buildModesCatalog } from '../../scripts/fixtures/modesCatalog'
import { runFixturePipeline } from '../../scripts/fixtures/pipeline'
import { toCanonicalJson } from '../../scripts/fixtures/serialize'

// Self-conformance for the golden chat fixtures in shared/fixtures/chat: the
// stored `expected` must equal a fresh normalize → reduce → group → project
// run over the stored `input`, and every file must be canonically serialized.
// A failure here means the web pipeline (or the projection) drifted — rerun
// `bun run gen:fixtures` from the repo root and commit the diff, which is what
// flips the native iOS/Android conformance suites red.

// Vitest runs with cwd = the project root (web/), regardless of where the
// suite was launched from. import.meta.url is not a file: URL under the
// jsdom transform, so resolve from cwd instead.
const fixturesDir = resolve(process.cwd(), '../shared/fixtures')
const chatDir = join(fixturesDir, 'chat')
const fixtureFiles = readdirSync(chatDir).filter((name) => name.endsWith('.json')).sort()

describe('shared/fixtures/chat golden fixtures', () => {
    it('has generated fixtures on disk', () => {
        expect(fixtureFiles.length).toBeGreaterThan(0)
    })

    it('VERSION matches the generator fixtureVersion', () => {
        expect(readFileSync(join(fixturesDir, 'VERSION'), 'utf8')).toBe(`${FIXTURE_VERSION}\n`)
    })

    for (const file of fixtureFiles) {
        describe(file, () => {
            const raw = readFileSync(join(chatDir, file), 'utf8')
            const document = JSON.parse(raw) as FixtureDocument

            it('is canonically serialized (sorted keys, 4-space indent, trailing LF)', () => {
                expect(toCanonicalJson(document)).toBe(raw)
            })

            it('carries the current fixtureVersion and a name matching its file', () => {
                expect(document.fixtureVersion).toBe(FIXTURE_VERSION)
                expect(`${document.name}.json`).toBe(file)
            })

            it('expected matches a fresh pipeline run over input', () => {
                const recomputed: unknown = JSON.parse(toCanonicalJson(runFixturePipeline(document.input)))
                expect(recomputed).toEqual(document.expected)
            })
        })
    }
})

describe('shared/fixtures/catalogs', () => {
    // modes.json is generated from shared/src/modes.ts (the module the web app
    // itself imports), so a stale file means the catalog generator was not
    // rerun after a modes change — same drift gate as the chat fixtures.
    it('modes.json matches a fresh build from shared/src/modes.ts (canonically serialized)', () => {
        const raw = readFileSync(join(fixturesDir, 'catalogs', 'modes.json'), 'utf8')
        expect(toCanonicalJson(JSON.parse(raw))).toBe(raw)
        expect(raw).toBe(toCanonicalJson(buildModesCatalog()))
    })
})
