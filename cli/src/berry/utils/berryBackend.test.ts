import { mkdtempSync } from 'node:fs'
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
    resolveBerryAcpCommand,
    resolveBerryDataDir
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
        // reason).
        const dataDir = mkdtempSync(join(tmpdir(), 'berry-data-test-'))
        const backend = createBerryBackend(
            { PATH: '/usr/bin' },
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
