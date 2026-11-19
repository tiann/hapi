import { spawn, execFileSync } from 'node:child_process'
import { watch, readdirSync, mkdirSync, mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { connect } from 'node:net'
import { EventEmitter, once } from 'node:events'
import { createHash } from 'node:crypto'
import { reached, type Fence } from './fences'
import { readLaunches } from './launchLog'
import assert from 'node:assert/strict'
import { fakeHub, type ScriptStep } from './fakeHub'
import { normalize } from './normalize'
import pkg from '../../package.json'

const parity = dirname(fileURLToPath(import.meta.url))
const cli = resolve(parity, '../..')
export const repo = resolve(cli, '..')
export const testTimeout = 150_000
export const corpus = join(parity, 'corpus/claude')
export const names = readdirSync(corpus, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
export async function run(name: string, binary?: string) {
    const startedAt = Date.now()
    const directory = join(corpus, name)
    const scenario: { argv: string[]; env: Record<string,string>; agentScript: string; timeoutMs: number
        hubScript: (ScriptStep & { until?: Fence | Fence[]; release?: { after: Fence; marker: string }[]
            settledAlive?: Record<string, unknown>; expectAck?: unknown })[] } =
        JSON.parse(readFileSync(join(directory, 'scenario.json'), 'utf8'))
    const out = mkdtempSync(join(tmpdir(), 'hapi-parity-'))
    const home = join(out, 'hapi')
    mkdirSync(home)
    const cwd = join(out, 'project')
    mkdirSync(cwd)
    const changes = new EventEmitter()
    const changed = () => { changes.emit('change') }
    const hub = await fakeHub(out, changed)
    const watcher = watch(out, (_, file) => { if (file === 'agent-error') changed() })
    const apiUrl = 'http://127.0.0.1:' + hub.port
    const machineId = 'parity-machine'
    const token = 'parity-token'
    const bun = process.env.HAPI_BUN_EXEC || 'bun'
    const env = {
        ...scenario.env, PATH: process.env.PATH, HOME: out, TMPDIR: out, HAPI_API_URL: apiUrl, HAPI_HOME: home,
        HAPI_RUNNER_HTTP_TIMEOUT: String(scenario.timeoutMs),
        CLI_API_TOKEN: token, HAPI_HOSTNAME: 'parity', HAPI_CLAUDE_PATH: join(parity, 'fakes/fake-claude.ts'),
        PARITY_AGENT_SCRIPT: join(directory, scenario.agentScript), PARITY_OUT: out, TZ: 'UTC', LC_ALL: 'C',
        HAPI_CLI_EXECUTABLE: join(cli, 'bin/hapi.cjs')
    }
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ machineId }))
    const runner = spawn(bun, [join(parity, 'fakes/runner.ts'), 'runner', 'start-sync'], { env, cwd, stdio: ['pipe', 'pipe', 'inherit'] })
    let port = 0
    createInterface({ input: runner.stdout }).on('line', line => {
        const data = JSON.parse(line)
        if (data.port) { port = data.port; changed() }
        else hub.record('POST /session-started', [data.webhook], false, 0)
    })
    let child: ReturnType<typeof spawn> | undefined
    let output = ''
    let runnerFailure: string | undefined
    runner.on('error', error => { runnerFailure = error.message; changed() })
    runner.on('exit', (code, signal) => { runnerFailure = 'runner exited ' + (signal ?? code); changed() })
    let exited = false
    const deadline = Date.now() + scenario.timeoutMs
    function wait(label: string, predicate: () => boolean) {
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                changes.off('change', check)
                reject(Error('Timed out waiting for ' + label + ' in ' + out + '\n' + output))
            }, Math.max(0, deadline - Date.now()))
            changes.on('change', check)
            check()
            function check() {
                try {
                    if (existsSync(join(out, 'agent-error'))) throw Error(readFileSync(join(out, 'agent-error'), 'utf8'))
                    if (runnerFailure) throw Error(runnerFailure)
                    if (!predicate()) {
                        if (!exited) return
                        throw Error('Wrapper exited ' + (child?.signalCode ?? child?.exitCode) + ' waiting for ' + label + ' in ' + out + '\n' + output)
                    }
                    resolve()
                } catch (error) {
                    reject(error)
                }
                clearTimeout(timer)
                changes.off('change', check)
            }
        })
    }
    try {
        await wait('runner', () => port > 0)
        writeFileSync(join(home, 'runner.state.json'), JSON.stringify({
            pid: runner.pid, httpPort: port, startedWithCliVersion: pkg.version, startedWithApiUrl: apiUrl,
            startedWithMachineId: machineId, startedWithCliApiTokenHash: createHash('sha256').update(token).digest('hex')
        }))
        child = spawn(binary ?? bun, [...(binary ? [] : [join(cli, 'src/index.ts')]), ...scenario.argv],
            { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
        child.stdout!.on('data', part => output += part)
        child.stderr!.on('data', part => output += part)
        child.on('error', error => { output += error.message; exited = true; changed() })
        child.on('exit', () => { exited = true; changed() })
        if (!child.pid) throw Error('Could not spawn ' + (binary ?? bun))
        const pid = child.pid
        const marker = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { env, encoding: 'utf8' }).trim()
        await wait('socket heartbeat and runner webhook', () => hub.rows.some(r => r.event === 'session-alive') &&
            hub.rows.some(r => r.event === 'POST /session-started'))
        runner.stdin.end('connected\n')
        await wait('startup registration and remote-mode acknowledgements', () => reached(hub.rows, [
            { event: 'rpc-register', contains: ':steer-queued-message' },
            { event: 'update-state', contains: '"controlledByUser":false', result: 'success' },
            { event: 'update-metadata', contains: '"startingMode":"remote"', result: 'success' }
        ]))
        writeFileSync(join(out, 'catalog-ready'), '')
        await wait('catalog acknowledgement', () => reached(hub.rows,
            { event: 'update-metadata', contains: '"slashCommands"', result: 'success' }))
        const endpoint = new URL((hub.session.metadata as unknown as { hapiMcpUrl: string }).hapiMcpUrl)
        assert.equal(endpoint.hostname, '127.0.0.1')
        const mcpPort = Number(endpoint.port)
        const probe = connect(mcpPort, '127.0.0.1')
        try { await once(probe, 'connect') } finally { probe.destroy() }
        for (const action of scenario.hubScript) {
            if (action.settledAlive) {
                const expected = Object.entries(action.settledAlive)
                await wait('settled heartbeat ' + JSON.stringify(action.settledAlive),
                    () => expected.every(([key, value]) => hub.latestAlive?.[key] === value))
            }
            const start = hub.rows.length
            await hub.execute(action, () => child!.kill('SIGTERM'), { pid, marker })
            for (const gate of action.release ?? []) {
                await wait(JSON.stringify(gate.after), () => reached(hub.rows.slice(start), gate.after))
                writeFileSync(join(out, gate.marker), '')
            }
            const fences = action.until
            if (fences) await wait(JSON.stringify(fences), () => reached(hub.rows.slice(start), fences))
            if (action.expectAck !== undefined) {
                const row = hub.rows.slice(start).find(r => ['rpc-ack','update-ack'].includes(r.event))
                assert.ok(row, 'Missing acknowledgement')
                const response = row.event === 'rpc-ack' ? JSON.parse(String(row.args[0])) : row.args[0]
                for (const [key, value] of Object.entries(action.expectAck as object)) {
                    assert.deepEqual(response[key], value)
                }
            }
        }
        await wait('clean exit', () => exited)
        assert.equal(child.exitCode, 0, output)
        const decoded = JSON.parse(execFileSync(bun, [join(parity, 'decode.ts')], {
            input: JSON.stringify(hub.rows), encoding: 'utf8', cwd
        }))
        const logs = readLaunches(out)
        return normalize(hub.rows, { pid, marker, cli, out, apiUrl, startedAt, mcpPort, endedAt: Date.now(), leaseExpiry: hub.leaseExpiry }, logs, decoded)
    } finally {
        if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
        watcher.close()
        runner.kill()
        await hub.close()
        if (!process.env.PARITY_KEEP_OUTPUT) rmSync(out, { recursive: true, force: true })
    }
}
