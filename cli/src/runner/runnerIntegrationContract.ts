import { lstatSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export type RunnerIntegrationContract = {
    root: string
    home: string
    eventFile: string
    ledgerFile: string
    hubDbPath: string
    workspace: string
}

function canonicalDirectory(path: string, label: string): string {
    const absolute = resolve(path)
    let node: ReturnType<typeof lstatSync>
    try {
        node = lstatSync(absolute)
    } catch {
        throw new Error(`${label} must exist`)
    }
    if (node.isSymbolicLink() || !node.isDirectory()) {
        throw new Error(`${label} must be a real directory`)
    }
    return realpathSync(absolute)
}

function canonicalRegularFile(path: string, label: string): string {
    const absolute = resolve(path)
    let node: ReturnType<typeof lstatSync>
    try {
        node = lstatSync(absolute)
    } catch {
        throw new Error(`${label} must exist`)
    }
    if (node.isSymbolicLink() || !node.isFile()) {
        throw new Error(`${label} must be a regular file`)
    }
    return realpathSync(absolute)
}

function isContainedBy(container: string, candidate: string): boolean {
    const contained = relative(container, candidate)
    return Boolean(contained && !contained.startsWith('..') && !isAbsolute(contained))
}

function isSameFile(left: string, right: string): boolean {
    if (left === right) return true
    const leftStat = statSync(left)
    const rightStat = statSync(right)
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
}

export function requireRunnerIntegrationContract(env: NodeJS.ProcessEnv): RunnerIntegrationContract {
    if (env.HAPI_RUNNER_INTEGRATION !== '1') {
        throw new Error('Use the dedicated test:runner-integration command')
    }
    if (env.NODE_ENV !== 'test' || env.HAPI_RUNNER_INTEGRATION_FIXTURE !== '1') {
        throw new Error('The deterministic Runner fixture contract is missing')
    }

    const homeInput = env.HAPI_HOME?.trim()
    const rootInput = env.HAPI_RUNNER_INTEGRATION_ROOT?.trim()
    const eventInput = env.HAPI_RUNNER_INTEGRATION_EVENT_FILE?.trim()
    const ledgerInput = env.HAPI_RUNNER_INTEGRATION_LEDGER_FILE?.trim()
    const hubDbInput = env.HAPI_RUNNER_INTEGRATION_HUB_DB_PATH?.trim()
    if (!homeInput || !rootInput || !eventInput || !ledgerInput || !hubDbInput
        || ![homeInput, rootInput, eventInput, ledgerInput, hubDbInput].every(isAbsolute)) {
        throw new Error('Runner integration root, homes, and evidence paths must be absolute')
    }

    const root = canonicalDirectory(rootInput, 'Runner integration root')
    const home = canonicalDirectory(homeInput, 'HAPI_HOME')
    if (!isContainedBy(root, home)) {
        throw new Error('HAPI_HOME must be contained by the isolated integration root')
    }
    const eventFile = canonicalRegularFile(eventInput, 'Runner integration event file')
    const ledgerFile = canonicalRegularFile(ledgerInput, 'Runner integration ledger file')
    if (!isContainedBy(home, eventFile) || !isContainedBy(home, ledgerFile)) {
        throw new Error('Runner integration evidence files must be contained by the isolated HAPI_HOME')
    }
    if (isSameFile(eventFile, ledgerFile)) {
        throw new Error('Runner integration event and ledger files must be distinct')
    }
    const hubDbPath = canonicalRegularFile(hubDbInput, 'Runner integration Hub database')
    if (!isContainedBy(root, hubDbPath)) {
        throw new Error('Hub database must be contained by the isolated integration root')
    }

    const apiUrl = new URL(env.HAPI_API_URL ?? '')
    if (!['127.0.0.1', 'localhost', '::1'].includes(apiUrl.hostname)) {
        throw new Error('Runner integration tests require a loopback Hub')
    }
    if (!env.CLI_API_TOKEN) {
        throw new Error('Runner integration tests require CLI_API_TOKEN')
    }

    return {
        root,
        home,
        eventFile,
        ledgerFile,
        hubDbPath,
        workspace: join(home, 'workspace')
    }
}
