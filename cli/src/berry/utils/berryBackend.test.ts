import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AcpSdkBackend } from '@/agent/backends/acp'

// Pin the home directory so path assertions stay machine-independent, while
// keeping the module's other exports intact (the logger reads it
// transitively through AcpStdioTransport).
vi.mock('@/configuration', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/configuration')>()
    return {
        ...actual,
        resolveHapiHomeDir: (env: NodeJS.ProcessEnv = {}) =>
            env.HAPI_HOME ?? join('/mock-home', '.hapi')
    }
})

import {
    berrySpawnEnvOverlay,
    createBerryBackend,
    ensureBerryDataDir,
    loadSqliteOpener,
    overrideSqliteOpenerForTests,
    resolveBerryAcpCommand,
    resolveBerryDataDir,
    resolveInteractiveBerryDataDir
} from './berryBackend'

describe('resolveBerryAcpCommand', () => {
    it('defaults to the berry CLI with the acp subcommand', () => {
        expect(resolveBerryAcpCommand({})).toEqual({
            command: 'berry',
            args: ['acp']
        })
    })

    it('keeps bare arguments for an explicitly configured server', () => {
        // Custom wrappers must not silently receive the official CLI's
        // `acp` subcommand; they opt into args via ARGS_JSON.
        expect(resolveBerryAcpCommand({ HAPI_BERRY_ACP_COMMAND: 'berry-acp-demo' })).toEqual({
            command: 'berry-acp-demo',
            args: []
        })
    })

    it('supports source checkouts and community servers through JSON args', () => {
        expect(resolveBerryAcpCommand({
            HAPI_BERRY_ACP_COMMAND: 'pnpm',
            HAPI_BERRY_ACP_ARGS_JSON: '["--dir", "/opt/berry", "run", "acp"]'
        })).toEqual({
            command: 'pnpm',
            args: ['--dir', '/opt/berry', 'run', 'acp']
        })
    })

    it('rejects shell-like or malformed argument values', () => {
        expect(() => resolveBerryAcpCommand({ HAPI_BERRY_ACP_ARGS_JSON: 'berry acp' }))
            .toThrow('HAPI_BERRY_ACP_ARGS_JSON must be a JSON array of strings')
        expect(() => resolveBerryAcpCommand({ HAPI_BERRY_ACP_ARGS_JSON: '["berry", 1]' }))
            .toThrow('HAPI_BERRY_ACP_ARGS_JSON must be a JSON array of strings')
    })
})

describe('resolveBerryDataDir', () => {
    it('keys the isolated data dir by the HAPI row id under ~/.hapi', () => {
        expect(resolveBerryDataDir('hapi-row-1', {})).toBe(
            join('/mock-home', '.hapi', 'berry-data', 'hapi-row-1')
        )
    })

    it('falls back to a shared default directory without a row id', () => {
        expect(resolveBerryDataDir(undefined, {})).toBe(
            join('/mock-home', '.hapi', 'berry-data', 'default')
        )
        expect(resolveBerryDataDir('', {})).toBe(
            join('/mock-home', '.hapi', 'berry-data', 'default')
        )
    })

    it('honors HAPI_HOME relocation', () => {
        expect(resolveBerryDataDir('hapi-row-1', { HAPI_HOME: '/srv/hapi' })).toBe(
            join('/srv/hapi', 'berry-data', 'hapi-row-1')
        )
    })
})

describe('berrySpawnEnvOverlay', () => {
    it('passes the spawn-time model and data dir levers', () => {
        expect(berrySpawnEnvOverlay(
            { model: 'newapi/glm-5.3', dataDir: '/srv/hapi/berry-data/row-1' },
            {}
        )).toEqual({
            BERRY_AGENT_MODEL: 'newapi/glm-5.3',
            BERRY_AGENT_DATA_DIR: '/srv/hapi/berry-data/row-1'
        })
    })

    it('keeps a machine-level BERRY_AGENT_MODEL authoritative', () => {
        // Berry reads the model lever only at spawn; an operator pinning it
        // on the machine env keeps control regardless of the session model.
        expect(berrySpawnEnvOverlay(
            { model: 'newapi/glm-5.3' },
            { BERRY_AGENT_MODEL: 'newapi/glm-5.3-flash' }
        )).toEqual({})
    })

    it('keeps a machine-level BERRY_AGENT_DATA_DIR authoritative', () => {
        expect(berrySpawnEnvOverlay(
            { dataDir: '/srv/hapi/berry-data/row-1' },
            { BERRY_AGENT_DATA_DIR: '/pin/berry' }
        )).toEqual({})
    })

    it('sets nothing without spawn-time options', () => {
        expect(berrySpawnEnvOverlay({}, { PATH: '/usr/bin' })).toEqual({})
        expect(berrySpawnEnvOverlay({ model: undefined, dataDir: undefined }, {})).toEqual({})
    })
})

describe('createBerryBackend spawn configuration', () => {
    it('pins the model lever, the isolated data dir, and delta chunk streaming', () => {
        // Berry streams pure agent_message_chunk deltas; the default overlap
        // dedupe drops repeated tokens (grok pins the same mode for the same
        // reason). HOME is pinned to an empty temp home so the provider
        // config seed never reads the developer's real ~/.berry-agent.
        const dataDir = mkdtempSync(join(tmpdir(), 'berry-data-test-'))
        const backend = createBerryBackend(
            { PATH: '/usr/bin', HOME: mkdtempSync(join(tmpdir(), 'berry-home-empty-')) },
            { model: 'newapi/glm-5.3', dataDir }
        )
        const options = (backend as unknown as {
            options: {
                env: Record<string, string | undefined>
                textChunkMode?: string
                flavor?: string
            }
        }).options

        expect(options.env.BERRY_AGENT_MODEL).toBe('newapi/glm-5.3')
        expect(options.env.BERRY_AGENT_DATA_DIR).toBe(dataDir)
        expect(options.env.PATH).toBe('/usr/bin')
        expect(options.textChunkMode).toBe('delta')
        expect(options.flavor).toBe('berry')
    })

    it('leaves the berry levers untouched when the machine env pins them', () => {
        const backend = createBerryBackend(
            {
                BERRY_AGENT_MODEL: 'newapi/glm-5.3-flash',
                BERRY_AGENT_DATA_DIR: '/pin/berry'
            },
            { model: 'newapi/glm-5.3', dataDir: '/srv/hapi/berry-data/row-1' }
        )
        const options = (backend as unknown as {
            options: { env: Record<string, string | undefined> }
        }).options

        expect(options.env.BERRY_AGENT_MODEL).toBe('newapi/glm-5.3-flash')
        expect(options.env.BERRY_AGENT_DATA_DIR).toBe('/pin/berry')
    })

    it('still streams deltas without any spawn-time options', () => {
        const backend = createBerryBackend({})
        const options = (backend as unknown as { options: { textChunkMode?: string } }).options
        expect(options.textChunkMode).toBe('delta')
    })

    it('constructs an AcpSdkBackend', () => {
        expect(createBerryBackend({})).toBeInstanceOf(AcpSdkBackend)
    })
})

/** Builds a fake interactive berry home (`<home>/.berry-agent/...`). */
function makeInteractiveBerryHome(): { home: string; interactiveDir: string } {
    const home = mkdtempSync(join(tmpdir(), 'berry-home-'))
    const interactiveDir = join(home, '.berry-agent')
    mkdirSync(interactiveDir)
    return { home, interactiveDir }
}

/* ------------------------------------------------------------------ *
 * Real sqlite fixtures                                                *
 *                                                                     *
 * The credentials seed snapshots a real store, so the fixtures build  *
 * real WAL-mode databases through the module's own sqlite loader      *
 * (bun:sqlite on Bun, node:sqlite on the vitest/Node rig).            *
 * ------------------------------------------------------------------ */

function sqlStringLiteral(value: string): string {
    return `'${value.replaceAll("'", "''")}'`
}

function requireSqliteOpener() {
    const opener = loadSqliteOpener()
    if (!opener) throw new Error('test rig requires a sqlite module (bun:sqlite or node:sqlite)')
    return opener
}

/** Berry's real credentials table (persist/schema.ts: provider/api_key/meta/updated_at, STRICT). */
const BERRY_CREDENTIALS_DDL = `CREATE TABLE credentials (
    provider   TEXT PRIMARY KEY,
    api_key    TEXT NOT NULL,
    meta       TEXT,
    updated_at INTEGER NOT NULL
) STRICT`

function createInteractiveSqliteStore(
    interactiveDir: string,
    providers: ReadonlyArray<{ provider: string; apiKey: string }>
): void {
    const db = requireSqliteOpener()(join(interactiveDir, 'sessions.db'), 'readwrite')
    try {
        db.exec('PRAGMA journal_mode = WAL')
        db.exec(BERRY_CREDENTIALS_DDL)
        for (const { provider, apiKey } of providers) {
            db.exec(
                `INSERT INTO credentials (provider, api_key, meta, updated_at) `
                + `VALUES (${sqlStringLiteral(provider)}, ${sqlStringLiteral(apiKey)}, NULL, 0)`
            )
        }
    } finally {
        db.close()
    }
}

function readCredentialProviders(dbPath: string): string[] {
    const db = requireSqliteOpener()(dbPath, 'readonly')
    try {
        const rows = db.readAll('SELECT provider FROM credentials ORDER BY provider') as Array<{ provider: string }>
        return rows.map((row) => row.provider)
    } finally {
        db.close()
    }
}

function writeInteractiveProviderConfig(interactiveDir: string): {
    customProviders: Record<string, unknown>
    settingsJson: string
} {
    const customProviders = {
        newapi: {
            protocol: 'openai-completions',
            baseUrl: 'https://newapi.example/v1',
            models: ['glm-5.3']
        }
    }
    const settingsJson = JSON.stringify({
        // Berry's own interactive defaults must NOT ride along.
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        customProviders
    })
    writeFileSync(join(interactiveDir, 'settings.json'), settingsJson, 'utf8')
    createInteractiveSqliteStore(interactiveDir, [
        { provider: 'newapi', apiKey: 'v1:cipher-for-newapi' }
    ])
    writeFileSync(join(interactiveDir, 'secret.key'), 'FAKE-SECRET-KEY', 'utf8')
    // Sticky permission grants are the one thing the isolated dir exists
    // to keep out.
    writeFileSync(join(interactiveDir, 'tool-policy.json'), '{"toolcall_bash":{"outcome":"allow_always"}}', 'utf8')
    return { customProviders, settingsJson }
}

/** Recursively writes a skill tree (`skills/<name>/SKILL.md`). */
function writeInteractiveSkills(interactiveDir: string, names: string[]): void {
    for (const name of names) {
        const skillDir = join(interactiveDir, 'skills', name)
        mkdirSync(skillDir, { recursive: true })
        writeFileSync(join(skillDir, 'SKILL.md'), `# ${name}\n\nbody\n`, 'utf8')
    }
}

describe('ensureBerryDataDir provider config seed', () => {
    it('resolves the interactive dir from the home directory env', () => {
        expect(resolveInteractiveBerryDataDir({ HOME: '/srv/home' })).toBe(join('/srv/home', '.berry-agent'))
        expect(resolveInteractiveBerryDataDir({ USERPROFILE: 'C:\\Users\\berry' })).toBe(join('C:\\Users\\berry', '.berry-agent'))
    })

    it('seeds provider config from the interactive dir on first creation', () => {
        const { home, interactiveDir } = makeInteractiveBerryHome()
        const { customProviders } = writeInteractiveProviderConfig(interactiveDir)
        writeInteractiveSkills(interactiveDir, ['pdf-tools'])
        const dataDir = join(mkdtempSync(join(tmpdir(), 'berry-data-seed-')), 'row-1')

        ensureBerryDataDir(dataDir, { HOME: home })

        // Provider definitions ride over — and ONLY them: berry's own
        // sandbox/approval defaults must not change HAPI session gating.
        expect(JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))).toEqual({ customProviders })
        // Stored provider auth: a consistent single-file snapshot of the
        // credentials store (opens on its own, rows intact) plus the key
        // that decrypts it.
        expect(readCredentialProviders(join(dataDir, 'sessions.db'))).toEqual(['newapi'])
        expect(existsSync(join(dataDir, 'sessions.db-wal'))).toBe(false)
        expect(readFileSync(join(dataDir, 'secret.key'), 'utf8')).toBe('FAKE-SECRET-KEY')
        // The interactive skills tree rides along (copy, not symlink).
        expect(readFileSync(join(dataDir, 'skills', 'pdf-tools', 'SKILL.md'), 'utf8')).toContain('pdf-tools')
        expect(lstatSync(join(dataDir, 'skills')).isSymbolicLink()).toBe(false)
        // Sticky permission grants stay isolated.
        expect(existsSync(join(dataDir, 'tool-policy.json'))).toBe(false)
    })

    it('snapshots credentials consistently while a live writer holds un-checkpointed WAL commits', () => {
        // The regression the snapshot exists for: berry commits live in the
        // WAL until a checkpoint runs, so a credentials row added moments
        // ago exists ONLY in sessions.db-wal. Copying db and WAL as two
        // separate files can pair mismatched generations; the seed must
        // instead produce a single file that already contains the row.
        const { home, interactiveDir } = makeInteractiveBerryHome()
        createInteractiveSqliteStore(interactiveDir, [
            { provider: 'newapi', apiKey: 'v1:cipher-for-newapi' }
        ])
        const dbPath = join(interactiveDir, 'sessions.db')
        const writer = requireSqliteOpener()(dbPath, 'readwrite')
        try {
            writer.exec('PRAGMA wal_autocheckpoint = 0')
            writer.exec(
                `INSERT INTO credentials (provider, api_key, meta, updated_at) `
                + `VALUES ('openrouter', 'v1:cipher-wal-only', NULL, 1)`
            )
            expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0)
            const dbBytesBefore = readFileSync(dbPath)
            const walBytesBefore = readFileSync(`${dbPath}-wal`)

            const dataDir = join(mkdtempSync(join(tmpdir(), 'berry-data-live-')), 'row-1')
            ensureBerryDataDir(dataDir, { HOME: home })

            // The seeded store opens on its own and carries the WAL-only
            // credential — no sidecar copied, source bytes untouched.
            expect(readCredentialProviders(join(dataDir, 'sessions.db'))).toEqual(['newapi', 'openrouter'])
            expect(existsSync(join(dataDir, 'sessions.db-wal'))).toBe(false)
            expect(Buffer.compare(readFileSync(dbPath), dbBytesBefore)).toBe(0)
            expect(Buffer.compare(readFileSync(`${dbPath}-wal`), walBytesBefore)).toBe(0)
        } finally {
            writer.close()
        }
    })

    it('snapshots credentials consistently from a crashed writer\u2019s hot WAL (no -shm)', () => {
        // A hard-killed berry leaves the WAL hot with no -shm; read-only
        // opens refuse that shape, so the ladder must escalate instead of
        // degrading to a racy two-file copy.
        const { home, interactiveDir } = makeInteractiveBerryHome()
        const dbPath = join(interactiveDir, 'sessions.db')
        const child = spawnSync(
            process.execPath,
            ['-e', `
                const { DatabaseSync } = require('node:sqlite');
                const db = new DatabaseSync(${JSON.stringify(dbPath)});
                db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
                db.exec(${JSON.stringify(BERRY_CREDENTIALS_DDL)});
                db.exec("INSERT INTO credentials (provider, api_key, meta, updated_at) VALUES ('newapi', 'v1:cipher', NULL, 0)");
                db.exec("INSERT INTO credentials (provider, api_key, meta, updated_at) VALUES ('openrouter', 'v1:cipher-wal-only', NULL, 1)");
                process.exit(0); // no close: WAL stays hot
            `],
            { encoding: 'utf8' }
        )
        expect(child.status).toBe(0)
        expect(existsSync(`${dbPath}-wal`)).toBe(true)
        rmSync(`${dbPath}-shm`, { force: true })

        const dataDir = join(mkdtempSync(join(tmpdir(), 'berry-data-crash-')), 'row-1')
        ensureBerryDataDir(dataDir, { HOME: home })

        expect(readCredentialProviders(join(dataDir, 'sessions.db'))).toEqual(['newapi', 'openrouter'])
        expect(existsSync(join(dataDir, 'sessions.db-wal'))).toBe(false)
    })

    it('seeds through createBerryBackend when it creates the isolated dir', () => {
        const { home, interactiveDir } = makeInteractiveBerryHome()
        writeInteractiveProviderConfig(interactiveDir)
        const dataDir = join(mkdtempSync(join(tmpdir(), 'berry-data-create-')), 'row-2')

        const backend = createBerryBackend({ HOME: home, PATH: '/usr/bin' }, { dataDir })

        expect(backend).toBeInstanceOf(AcpSdkBackend)
        expect(existsSync(join(dataDir, 'secret.key'))).toBe(true)
        expect(existsSync(join(dataDir, 'settings.json'))).toBe(true)
        expect(existsSync(join(dataDir, 'sessions.db'))).toBe(true)
    })

    it('never reseeds or overwrites an existing directory', () => {
        const { home, interactiveDir } = makeInteractiveBerryHome()
        writeInteractiveProviderConfig(interactiveDir)
        const dataDir = join(mkdtempSync(join(tmpdir(), 'berry-data-reseed-')), 'row-3')
        ensureBerryDataDir(dataDir, { HOME: home })

        // Berry (or a later run) owns the dir from here on: new source
        // content must not leak in, and files berry wrote stay untouched.
        const settingsPath = join(dataDir, 'settings.json')
        writeFileSync(settingsPath, '{"customProviders":{"other":{"protocol":"openai-completions","baseUrl":"https://x.example","models":[]}}}', 'utf8')
        writeFileSync(join(interactiveDir, 'settings.json'), JSON.stringify({ customProviders: { added: 'later' } }), 'utf8')
        writeFileSync(join(interactiveDir, 'secret.key'), 'ROTATED-KEY', 'utf8')

        ensureBerryDataDir(dataDir, { HOME: home })

        expect(readFileSync(settingsPath, 'utf8')).toContain('other')
        expect(readFileSync(join(dataDir, 'secret.key'), 'utf8')).toBe('FAKE-SECRET-KEY')
    })

    it('skips provider settings when the interactive dir has no custom providers', () => {
        const { home, interactiveDir } = makeInteractiveBerryHome()
        writeFileSync(join(interactiveDir, 'settings.json'), JSON.stringify({ sandboxMode: 'read-only' }), 'utf8')
        writeFileSync(join(interactiveDir, 'secret.key'), 'FAKE-SECRET-KEY', 'utf8')
        const dataDir = join(mkdtempSync(join(tmpdir(), 'berry-data-nocp-')), 'row-4')

        ensureBerryDataDir(dataDir, { HOME: home })

        // No custom providers → no settings seed, but stored provider auth
        // (built-in providers keep their keys in the same store) still
        // rides over.
        expect(existsSync(join(dataDir, 'settings.json'))).toBe(false)
        expect(readFileSync(join(dataDir, 'secret.key'), 'utf8')).toBe('FAKE-SECRET-KEY')
    })

    it('degrades to an empty dir when the interactive dir is missing or unreadable', () => {
        const emptyHome = mkdtempSync(join(tmpdir(), 'berry-home-empty-'))
        const dataDir = join(mkdtempSync(join(tmpdir(), 'berry-data-failopen-')), 'row-5')

        expect(() => ensureBerryDataDir(dataDir, { HOME: emptyHome })).not.toThrow()
        expect(existsSync(dataDir)).toBe(true)
        // Fresh machine: nothing seeded, berry still boots on an empty dir.
        const backend = createBerryBackend(
            { PATH: '/usr/bin', HOME: emptyHome },
            { dataDir: join(mkdtempSync(join(tmpdir(), 'berry-data-failopen2-')), 'row-6') }
        )
        expect(backend).toBeInstanceOf(AcpSdkBackend)
    })

    it('tolerates a malformed interactive settings.json', () => {
        const { home, interactiveDir } = makeInteractiveBerryHome()
        writeFileSync(join(interactiveDir, 'settings.json'), '{not json', 'utf8')
        const dataDir = join(mkdtempSync(join(tmpdir(), 'berry-data-badjson-')), 'row-7')

        expect(() => ensureBerryDataDir(dataDir, { HOME: home })).not.toThrow()
        expect(existsSync(join(dataDir, 'settings.json'))).toBe(false)
    })

    it('skips the database seed (never a racy pair copy) when the source is not a database', () => {
        const { home, interactiveDir } = makeInteractiveBerryHome()
        writeFileSync(join(interactiveDir, 'sessions.db'), 'NOT-A-SQLITE-FILE', 'utf8')
        writeFileSync(join(interactiveDir, 'sessions.db-wal'), 'NOT-A-WAL', 'utf8')
        writeFileSync(join(interactiveDir, 'secret.key'), 'FAKE-SECRET-KEY', 'utf8')
        const dataDir = join(mkdtempSync(join(tmpdir(), 'berry-data-junkdb-')), 'row-8')

        expect(() => ensureBerryDataDir(dataDir, { HOME: home })).not.toThrow()
        // Degrade = no database seed at all: a junk or mismatched pair copy
        // is exactly the corruption the snapshot ladder avoids.
        expect(existsSync(join(dataDir, 'sessions.db'))).toBe(false)
        expect(existsSync(join(dataDir, 'sessions.db-wal'))).toBe(false)
        // Independent seeds still land; berry still boots.
        expect(readFileSync(join(dataDir, 'secret.key'), 'utf8')).toBe('FAKE-SECRET-KEY')
    })

    it('skips the database seed when no sqlite module is available', () => {
        const { home, interactiveDir } = makeInteractiveBerryHome()
        writeInteractiveProviderConfig(interactiveDir)
        const dataDir = join(mkdtempSync(join(tmpdir(), 'berry-data-nosqlite-')), 'row-9')
        overrideSqliteOpenerForTests(null)
        try {
            expect(() => ensureBerryDataDir(dataDir, { HOME: home })).not.toThrow()
        } finally {
            overrideSqliteOpenerForTests(undefined)
        }

        expect(existsSync(join(dataDir, 'sessions.db'))).toBe(false)
        expect(existsSync(join(dataDir, 'sessions.db-wal'))).toBe(false)
        expect(readFileSync(join(dataDir, 'secret.key'), 'utf8')).toBe('FAKE-SECRET-KEY')
        expect(existsSync(join(dataDir, 'settings.json'))).toBe(true)
    })
})

describe('ensureBerryDataDir skills seed', () => {
    it('carries the interactive skills tree over with nested directories', () => {
        const { home, interactiveDir } = makeInteractiveBerryHome()
        writeInteractiveSkills(interactiveDir, ['pdf-tools', 'repo-bisect/inner'])
        const dataDir = join(mkdtempSync(join(tmpdir(), 'berry-skills-seed-')), 'row-1')

        ensureBerryDataDir(dataDir, { HOME: home })

        expect(readFileSync(join(dataDir, 'skills', 'pdf-tools', 'SKILL.md'), 'utf8')).toContain('pdf-tools')
        expect(existsSync(join(dataDir, 'skills', 'repo-bisect', 'inner', 'SKILL.md'))).toBe(true)
    })

    it('leaves the skills root absent when the interactive profile has none', () => {
        const { home, interactiveDir } = makeInteractiveBerryHome()
        writeFileSync(join(interactiveDir, 'secret.key'), 'FAKE-SECRET-KEY', 'utf8')
        const dataDir = join(mkdtempSync(join(tmpdir(), 'berry-skills-none-')), 'row-2')

        ensureBerryDataDir(dataDir, { HOME: home })

        expect(existsSync(join(dataDir, 'skills'))).toBe(false)
    })

    it('degrades when the skills tree cannot be copied', () => {
        const { home, interactiveDir } = makeInteractiveBerryHome()
        writeInteractiveSkills(interactiveDir, ['locked'])
        const unreadable = join(interactiveDir, 'skills', 'locked', 'SKILL.md')
        chmodSync(unreadable, 0o000)
        writeFileSync(join(interactiveDir, 'secret.key'), 'FAKE-SECRET-KEY', 'utf8')
        const dataDir = join(mkdtempSync(join(tmpdir(), 'berry-skills-fail-')), 'row-3')
        try {
            expect(() => ensureBerryDataDir(dataDir, { HOME: home })).not.toThrow()
        } finally {
            chmodSync(unreadable, 0o600)
        }

        // The skills seed fails open: nothing half-copied, no staging
        // leftovers, and the other seeds still land.
        expect(existsSync(join(dataDir, 'skills'))).toBe(false)
        expect(readdirSync(dataDir).some((name) => name.startsWith('skills.hapi-seed-'))).toBe(false)
        expect(readFileSync(join(dataDir, 'secret.key'), 'utf8')).toBe('FAKE-SECRET-KEY')
    })

    it('never overwrites skills berry already created in the isolated dir', () => {
        const { home, interactiveDir } = makeInteractiveBerryHome()
        writeInteractiveSkills(interactiveDir, ['interactive-skill'])
        const dataDir = join(mkdtempSync(join(tmpdir(), 'berry-skills-keep-')), 'row-4')
        mkdirSync(join(dataDir, 'skills'), { recursive: true })
        writeFileSync(join(dataDir, 'skills', 'SKILL.md'), 'berry-owned', 'utf8')
        // Re-create the rest of the first-creation path: the dir already
        // exists, so the whole seed (skills included) must be a no-op.
        ensureBerryDataDir(dataDir, { HOME: home })

        expect(readFileSync(join(dataDir, 'skills', 'SKILL.md'), 'utf8')).toBe('berry-owned')
        expect(existsSync(join(dataDir, 'skills', 'interactive-skill'))).toBe(false)
    })
})
