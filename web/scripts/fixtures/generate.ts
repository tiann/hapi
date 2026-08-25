import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureCases } from './cases'
import { FIXTURE_VERSION, toFixtureInput, type FixtureCase, type FixtureDocument, type FixtureInput } from './fixtureTypes'
import { buildModesCatalog } from './modesCatalog'
import { buildPaginationFixtureDocument } from './pagination/build'
import { paginationFixtureCases } from './pagination/cases'
import { runFixturePipeline } from './pipeline'
import { toCanonicalJson } from './serialize'
import { buildSseFixtureDocument } from './sse/build'
import { sseFixtureCases } from './sse/cases'

const FIXTURES_DIR = fileURLToPath(new URL('../../../shared/fixtures', import.meta.url))

export function buildFixtureDocument(fixtureCase: FixtureCase): FixtureDocument {
    // Round-trip the input through canonical JSON before running the pipeline,
    // so `expected` is computed from exactly the bytes the file will carry —
    // a consumer re-running `input` can never see values the generator had
    // but the stored JSON does not (e.g. authored `undefined`).
    const input = JSON.parse(toCanonicalJson(toFixtureInput(fixtureCase))) as FixtureInput
    return {
        fixtureVersion: FIXTURE_VERSION,
        name: fixtureCase.name,
        description: fixtureCase.description,
        input,
        expected: runFixturePipeline(input)
    }
}

type SuiteWriter = {
    dir: string
    names: Set<string>
}

function openSuite(suite: string): SuiteWriter {
    const dir = join(FIXTURES_DIR, suite)
    mkdirSync(dir, { recursive: true })
    return { dir, names: new Set() }
}

function writeSuiteDocument(writer: SuiteWriter, name: string, document: unknown): void {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
        throw new Error(`Fixture name must be kebab-case: ${name}`)
    }
    if (writer.names.has(name)) {
        throw new Error(`Duplicate fixture name: ${name}`)
    }
    writer.names.add(name)
    writeFileSync(join(writer.dir, `${name}.json`), toCanonicalJson(document))
}

// Remove stale fixtures from renamed/deleted cases so natives never keep
// passing against a file the web pipeline no longer generates.
function pruneSuite(writer: SuiteWriter): void {
    for (const entry of readdirSync(writer.dir)) {
        if (entry.endsWith('.json') && !writer.names.has(entry.slice(0, -'.json'.length))) {
            unlinkSync(join(writer.dir, entry))
        }
    }
}

export async function generateAllFixtures(): Promise<void> {
    const chat = openSuite('chat')
    for (const fixtureCase of fixtureCases) {
        writeSuiteDocument(chat, fixtureCase.name, buildFixtureDocument(fixtureCase))
    }
    pruneSuite(chat)

    const sse = openSuite('sse')
    for (const fixtureCase of sseFixtureCases) {
        writeSuiteDocument(sse, fixtureCase.name, buildSseFixtureDocument(fixtureCase))
    }
    pruneSuite(sse)

    const pagination = openSuite('pagination')
    for (const fixtureCase of paginationFixtureCases) {
        writeSuiteDocument(pagination, fixtureCase.name, await buildPaginationFixtureDocument(fixtureCase))
    }
    pruneSuite(pagination)

    // Catalogs: reference tables generated from shared/src modules (not from
    // the chat pipeline). Same canonical serialization and drift gate.
    const catalogsDir = join(FIXTURES_DIR, 'catalogs')
    mkdirSync(catalogsDir, { recursive: true })
    writeFileSync(join(catalogsDir, 'modes.json'), toCanonicalJson(buildModesCatalog()))

    writeFileSync(join(FIXTURES_DIR, 'VERSION'), `${FIXTURE_VERSION}\n`)
    console.log(
        `Wrote ${chat.names.size} chat + ${sse.names.size} sse + ${pagination.names.size} pagination fixtures `
        + `+ catalogs/modes.json (fixtureVersion ${FIXTURE_VERSION}) to ${FIXTURES_DIR}`
    )
}
