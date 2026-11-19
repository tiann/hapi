#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, existsSync, watch } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { claimLaunch } from '../launchLog'
import { getProjectPath } from '../../claude/utils/path'

interface AgentStep {
    expectStdin?: unknown
    emit: unknown[]
    awaitMarker?: string
    exit?: number
    invocation?: number
}

function matches(actual: any, expected: any): boolean {
    if (expected === null || typeof expected !== 'object') return actual === expected
    return !!actual && Object.entries(expected).every(([k, v]) => matches(actual[k], v))
}

const out = process.env.PARITY_OUT!
const argv = process.argv.slice(2)
const probe = argv.includes('--print')
const versionProbe = argv.includes('--version')
const launch = claimLaunch(out, versionProbe ? 'version' : probe ? 'probe' : 'agent')
const log = { argv, env: process.env, stdin: [] as unknown[], completed: 0 }
const save = () => launch.save(log)
async function waitMarker(name: string) {
    await new Promise<void>((resolve, reject) => {
        const check = () => {
            if (existsSync(join(out, name))) {
                watcher.close()
                resolve()
            }
        }
        const watcher = watch(out, check).on('error', reject)
        check()
    })
}
save()
function emit(line: any) {
    if (line.type === 'system' && line.subtype === 'init' && line.session_id) {
        const dir = getProjectPath(process.cwd())
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, line.session_id + '.jsonl'), JSON.stringify({ ...line, uuid: line.session_id }) + '\n')
    }
    process.stdout.write((typeof line === 'string' ? line : JSON.stringify(line)) + '\n')
}
if (versionProbe) {
    console.log('2.1.223 (Claude Code)')
} else if (probe) {
    await waitMarker('catalog-ready')
    emit({ type: 'system', subtype: 'init', tools: ['Bash'], slash_commands: ['compact'] })
} else {
    const script: AgentStep[] = readFileSync(process.env.PARITY_AGENT_SCRIPT!, 'utf8').split('\n').filter(Boolean)
        .map(line => JSON.parse(line)).filter(step => !step.invocation || step.invocation === launch.index)
    const input = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
    async function read() {
        const next = await input.next()
        if (next.done) process.exit(0)
        const line = JSON.parse(next.value)
        log.stdin.push(line)
        save()
        if (line.type === 'control_request') emit({ type: 'control_response', response: {
            subtype: 'success', request_id: line.request_id, response: {}
        } })
        return line
    }
    try {
        for (const step of script) {
            let matched
            if (step.expectStdin) {
                let line = await read()
                while (!matches(line, step.expectStdin) && line.type === 'control_request') line = await read()
                matched = line
                assert.ok(matches(line, step.expectStdin), JSON.stringify({ expected: step.expectStdin, received: line }))
            }
            if (step.awaitMarker) await waitMarker(step.awaitMarker)
            for (const line of step.emit) emit(line === "$replay" ? { ...matched, isReplay: true } : line)
            log.completed++
            save()
            if (step.exit !== undefined) process.exit(step.exit)
        }
        while (true) await read()
    } catch (error) {
        writeFileSync(join(out, 'agent-error'), String(error))
        process.exit(1)
    }
}
