import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
    writeFileSync(join(interactiveDir, 'sessions.db'), 'FAKE-SESSIONS-DB', 'utf8')
    writeFileSync(join(interactiveDir, 'sessions.db-wal'), 'FAKE-WAL', 'utf8')
    writeFileSync(join(interactiveDir, 'secret.key'), 'FAKE-SECRET-KEY', 'utf8')
    // Sticky permission grants are the one thing the isolated dir exists
    // to keep out.
    writeFileSync(join(interactiveDir, 'tool-policy.json'), '{"toolcall_bash":{"outcome":"allow_always"}}', 'utf8')
    return { customProviders, settingsJson }
}

describe('ensureBerryDataDir provider config seed', () => {
    it('resolves the interactive dir from the home directory env', () => {
        expect(resolveInteractiveBerryDataDir({ HOME: '/srv/home' })).toBe(join('/srv/home', '.berry-agent'))
        expect(resolveInteractiveBerryDataDir({ USERPROFILE: 'C:\\Users\\berry' })).toBe(join('C:\\Users\\berry', '.berry-agent'))
    })

    it('seeds provider config from the interactive dir on first creation', () => {
        const { home, interactiveDir } = makeInteractiveBerryHome()
        const { customProviders } = writeInteractiveProviderConfig(interactiveDir)
        const dataDir = join(mkdtempSync(join(tmpdir(), 'berry-data-seed-')), 'row-1')

        ensureBerryDataDir(dataDir, { HOME: home })

        // Provider definitions ride over — and ONLY them: berry's own
        // sandbox/approval defaults must not change HAPI session gating.
        expect(JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))).toEqual({ customProviders })
        // Stored provider auth: credentials table (sessions.db + its WAL
        // sidecar) and the key that decrypts it.
        expect(readFileSync(join(dataDir, 'sessions.db'), 'utf8')).toBe('FAKE-SESSIONS-DB')
        expect(readFileSync(join(dataDir, 'sessions.db-wal'), 'utf8')).toBe('FAKE-WAL')
        expect(readFileSync(join(dataDir, 'secret.key'), 'utf8')).toBe('FAKE-SECRET-KEY')
        // Sticky permission grants stay isolated.
        expect(existsSync(join(dataDir, 'tool-policy.json'))).toBe(false)
    })

    it('seeds through createBerryBackend when it creates the isolated dir', () => {
        const { home, interactiveDir } = makeInteractiveBerryHome()
        writeInteractiveProviderConfig(interactiveDir)
        const dataDir = join(mkdtempSync(join(tmpdir(), 'berry-data-create-')), 'row-2')

        const backend = createBerryBackend({ HOME: home, PATH: '/usr/bin' }, { dataDir })

        expect(backend).toBeInstanceOf(AcpSdkBackend)
        expect(existsSync(join(dataDir, 'secret.key'))).toBe(true)
        expect(existsSync(join(dataDir, 'settings.json'))).toBe(true)
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
})
