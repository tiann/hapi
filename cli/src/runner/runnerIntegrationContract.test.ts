import { spawnSync } from 'node:child_process'
import { access, link, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { requireRunnerIntegrationContract } from './runnerIntegrationContract'

const temporaryPaths: string[] = []

afterEach(async () => {
    await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createFixtureRoot(): Promise<{
    root: string
    home: string
    hubDb: string
    eventFile: string
    ledgerFile: string
}> {
    const root = await mkdtemp(join(tmpdir(), 'hapi-runner-contract-'))
    temporaryPaths.push(root)
    const home = join(root, 'cli')
    const hub = join(root, 'hub')
    await mkdir(home)
    await mkdir(hub)
    const hubDb = join(hub, 'hapi.db')
    const eventFile = join(home, 'events.jsonl')
    const ledgerFile = join(home, 'ledger.jsonl')
    await writeFile(hubDb, '')
    await writeFile(eventFile, '')
    await writeFile(ledgerFile, '')
    return { root, home, hubDb, eventFile, ledgerFile }
}

function env(input: {
    root: string
    home: string
    hubDb: string
    eventFile: string
    ledgerFile: string
}, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
        HAPI_RUNNER_INTEGRATION: '1',
        NODE_ENV: 'test',
        HAPI_RUNNER_INTEGRATION_FIXTURE: '1',
        HAPI_HOME: input.home,
        HAPI_RUNNER_INTEGRATION_ROOT: input.root,
        HAPI_RUNNER_INTEGRATION_EVENT_FILE: input.eventFile,
        HAPI_RUNNER_INTEGRATION_LEDGER_FILE: input.ledgerFile,
        HAPI_RUNNER_INTEGRATION_HUB_DB_PATH: input.hubDb,
        HAPI_API_URL: 'http://127.0.0.1:31006',
        CLI_API_TOKEN: 'test-token',
        ...overrides
    }
}

describe('Runner integration contract', () => {
    it('accepts an ancestor alias when every final node is real and inside the same isolated root', async () => {
        const fixture = await createFixtureRoot()
        const parentAlias = `${fixture.root}-parent-alias`
        temporaryPaths.push(parentAlias)
        await symlink(dirname(fixture.root), parentAlias, 'dir')
        const alias = join(parentAlias, basename(fixture.root))

        const contract = requireRunnerIntegrationContract(env(fixture, {
            HAPI_HOME: join(alias, 'cli'),
            HAPI_RUNNER_INTEGRATION_ROOT: alias,
            HAPI_RUNNER_INTEGRATION_EVENT_FILE: fixture.eventFile,
            HAPI_RUNNER_INTEGRATION_LEDGER_FILE: join(alias, 'cli', 'ledger.jsonl')
        }))

        const canonicalRoot = await realpath(fixture.root)
        const canonicalHome = await realpath(fixture.home)
        expect(contract.root).toBe(canonicalRoot)
        expect(contract.home).toBe(canonicalHome)
        expect(contract.eventFile).toBe(join(canonicalHome, 'events.jsonl'))
        expect(contract.ledgerFile).toBe(join(canonicalHome, 'ledger.jsonl'))
        expect(contract.hubDbPath).toBe(await realpath(fixture.hubDb))
    })

    it('rejects evidence files that escape, use a final symlink, share one inode, or are missing', async () => {
        const fixture = await createFixtureRoot()
        const outside = await mkdtemp(join(tmpdir(), 'hapi-runner-contract-outside-'))
        temporaryPaths.push(outside)
        const outsideFile = join(outside, 'outside.jsonl')
        await writeFile(outsideFile, '')

        expect(() => requireRunnerIntegrationContract(env(fixture, {
            HAPI_RUNNER_INTEGRATION_EVENT_FILE: outsideFile
        }))).toThrow(/contained by the isolated HAPI_HOME/)

        const eventFile = join(fixture.home, 'events.jsonl')
        await writeFile(eventFile, '')
        const eventAlias = join(fixture.home, 'event-alias.jsonl')
        await symlink(eventFile, eventAlias)
        expect(() => requireRunnerIntegrationContract(env(fixture, {
            HAPI_RUNNER_INTEGRATION_EVENT_FILE: eventFile,
            HAPI_RUNNER_INTEGRATION_LEDGER_FILE: eventAlias
        }))).toThrow(/regular file/)

        const eventHardlink = join(fixture.home, 'event-hardlink.jsonl')
        await link(eventFile, eventHardlink)
        expect(() => requireRunnerIntegrationContract(env(fixture, {
            HAPI_RUNNER_INTEGRATION_EVENT_FILE: eventFile,
            HAPI_RUNNER_INTEGRATION_LEDGER_FILE: eventHardlink
        }))).toThrow(/must be distinct/)

        expect(() => requireRunnerIntegrationContract(env(fixture, {
            HAPI_RUNNER_INTEGRATION_EVENT_FILE: join(fixture.home, 'missing', 'events.jsonl')
        }))).toThrow(/must exist/)
    })

    it('rejects an existing evidence symlink that resolves outside the isolated home', async () => {
        const fixture = await createFixtureRoot()
        const outside = await mkdtemp(join(tmpdir(), 'hapi-runner-contract-symlink-'))
        temporaryPaths.push(outside)
        const target = join(outside, 'events.jsonl')
        await writeFile(target, '')
        const eventLink = join(fixture.home, 'events-link.jsonl')
        await symlink(target, eventLink)

        expect(() => requireRunnerIntegrationContract(env(fixture, {
            HAPI_RUNNER_INTEGRATION_EVENT_FILE: eventLink
        }))).toThrow(/regular file/)
    })

    it('rejects a Hub database outside the canonical integration root', async () => {
        const fixture = await createFixtureRoot()
        const outside = await mkdtemp(join(tmpdir(), 'hapi-runner-contract-db-'))
        temporaryPaths.push(outside)
        const outsideDb = join(outside, 'hapi.db')
        await writeFile(outsideDb, '')

        expect(() => requireRunnerIntegrationContract(env(fixture, {
            HAPI_RUNNER_INTEGRATION_HUB_DB_PATH: outsideDb
        }))).toThrow(/Hub database must be contained by the isolated integration root/)
    })

    it('rejects dangling links, directories, FIFOs, and final root or home symlinks', async () => {
        const fixture = await createFixtureRoot()
        const outside = await mkdtemp(join(tmpdir(), 'hapi-runner-contract-nodes-'))
        temporaryPaths.push(outside)
        const danglingTarget = join(outside, 'not-created.jsonl')
        const danglingLink = join(fixture.home, 'dangling.jsonl')
        await symlink(danglingTarget, danglingLink)

        expect(() => requireRunnerIntegrationContract(env(fixture, {
            HAPI_RUNNER_INTEGRATION_EVENT_FILE: danglingLink
        }))).toThrow(/regular file/)
        await expect(access(danglingTarget)).rejects.toMatchObject({ code: 'ENOENT' })

        const eventDirectory = join(fixture.home, 'event-directory')
        await mkdir(eventDirectory)
        expect(() => requireRunnerIntegrationContract(env(fixture, {
            HAPI_RUNNER_INTEGRATION_EVENT_FILE: eventDirectory
        }))).toThrow(/regular file/)

        if (process.platform !== 'win32') {
            const fifo = join(fixture.home, 'event-fifo')
            const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' })
            expect(created.status, String(created.stderr)).toBe(0)
            expect(() => requireRunnerIntegrationContract(env(fixture, {
                HAPI_RUNNER_INTEGRATION_EVENT_FILE: fifo
            }))).toThrow(/regular file/)
        }

        const rootLink = `${fixture.root}-link`
        temporaryPaths.push(rootLink)
        await symlink(fixture.root, rootLink, 'dir')
        expect(() => requireRunnerIntegrationContract(env(fixture, {
            HAPI_RUNNER_INTEGRATION_ROOT: rootLink,
            HAPI_HOME: join(rootLink, 'cli'),
            HAPI_RUNNER_INTEGRATION_EVENT_FILE: join(rootLink, 'cli', 'events.jsonl'),
            HAPI_RUNNER_INTEGRATION_LEDGER_FILE: join(rootLink, 'cli', 'ledger.jsonl'),
            HAPI_RUNNER_INTEGRATION_HUB_DB_PATH: join(rootLink, 'hub', 'hapi.db')
        }))).toThrow(/real directory/)

        const homeLink = join(fixture.root, 'cli-link')
        await symlink(fixture.home, homeLink, 'dir')
        expect(() => requireRunnerIntegrationContract(env(fixture, {
            HAPI_HOME: homeLink,
            HAPI_RUNNER_INTEGRATION_EVENT_FILE: join(homeLink, 'events.jsonl'),
            HAPI_RUNNER_INTEGRATION_LEDGER_FILE: join(homeLink, 'ledger.jsonl')
        }))).toThrow(/real directory/)
    })
})
