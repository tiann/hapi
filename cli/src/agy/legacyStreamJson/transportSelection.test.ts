import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { needsStreamJson, parseAgyVersion, probeAgyVersion } from './agyVersion'

const harness = vi.hoisted(() => ({
    agyCommand: 'agy',
    acpLaunches: 0,
    acpError: null as Error | null,
    streamJsonLaunches: 0,
    warn: vi.fn(),
}))

vi.mock('@/agent/agentLaunchCommand', () => ({ getAgentLaunchCommand: () => harness.agyCommand }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: harness.warn } }))
vi.mock('../agyAcpRemoteLauncher', () => {
    class AgyAcpStartError extends Error {}
    return {
        AgyAcpStartError,
        agyAcpRemoteLauncher: async () => {
            harness.acpLaunches += 1
            if (harness.acpError) throw harness.acpError
            return 'exit'
        },
    }
})
vi.mock('./agyHeadlessDriver', () => ({
    agyHeadlessDriver: async () => { harness.streamJsonLaunches += 1; return 'exit' },
}))

import { agyRemoteLauncher } from '../agyRemoteLauncher'
import { AgyAcpStartError } from '../agyAcpRemoteLauncher'

describe('needsStreamJson', () => {
    it.each([
        ['1.4.12\n', true],
        ['1.5.0\n', false],
        ['1.5.2\n', false],
        ['agy version 2.0.0\n', false],
        ['1.5.0-rc.1\n', true],
        ['1.5.1-beta\n', false],
        ['2.0\n', false],
        ['1.4\n', true],
        ['v1.4.12\n', true],
        ['agy v1.5.2\n', false],
    ])('reads %j', async (output, streamJson) => {
        const choice = await needsStreamJson(async () => output)
        expect(choice.streamJson).toBe(streamJson)
    })

    it('falls back to stream-json when the version cannot be read', async () => {
        expect(await needsStreamJson(async () => { throw new Error('spawn agy ENOENT') })).toEqual({
            streamJson: true,
            reason: 'could not read the agy version (spawn agy ENOENT)'
        })
        expect(await needsStreamJson(async () => 'dev build')).toEqual({
            streamJson: true,
            reason: 'could not read the agy version from "dev build"'
        })
    })

    it('parses dotted versions with optional patch and pre-release', () => {
        expect(parseAgyVersion('1.5.2')).toEqual({ core: [1, 5, 2], prerelease: false })
        expect(parseAgyVersion('2.0')).toEqual({ core: [2, 0, 0], prerelease: false })
        expect(parseAgyVersion('1.5.0-rc.1')).toEqual({ core: [1, 5, 0], prerelease: true })
        expect(parseAgyVersion('v1.4.12')).toEqual({ core: [1, 4, 12], prerelease: false })
        expect(parseAgyVersion('none')).toBeNull()
    })
})

describe('agyRemoteLauncher transport selection', () => {
    let dir: string

    function fakeAgy(script: string): void {
        const path = join(dir, 'agy')
        writeFileSync(path, `#!/bin/sh\n${script}\n`)
        chmodSync(path, 0o755)
        harness.agyCommand = path
    }

    function fakeSession(metadata: Record<string, unknown> = { agyProtocol: 'acp' }) {
        const state = { metadata, events: [] as unknown[] }
        return {
            state,
            session: {
                sendSessionEvent: (event: unknown) => { state.events.push(event) },
                client: {
                    updateMetadata: (update: (current: Record<string, unknown>) => Record<string, unknown>) => {
                        state.metadata = update(state.metadata)
                    }
                }
            }
        }
    }

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'agy-version-'))
        harness.acpLaunches = 0
        harness.acpError = null
        harness.streamJsonLaunches = 0
        harness.warn.mockClear()
    })

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    it('runs agy 1.5.0 and newer on agy acp', async () => {
        fakeAgy('echo 1.5.2')
        const { session, state } = fakeSession()

        await agyRemoteLauncher(session as never)

        expect(harness.acpLaunches).toBe(1)
        expect(harness.streamJsonLaunches).toBe(0)
        expect(state.metadata).toEqual({ agyProtocol: 'acp' })
    })

    it('runs older agy on stream-json and drops a stale ACP marker', async () => {
        fakeAgy('echo 1.4.12')
        const { session, state } = fakeSession({ agySessionId: 'conv-1', agyProtocol: 'acp' })

        await agyRemoteLauncher(session as never)

        expect(harness.streamJsonLaunches).toBe(1)
        expect(harness.acpLaunches).toBe(0)
        expect(state.metadata).toEqual({ agySessionId: 'conv-1' })
        expect(harness.warn).toHaveBeenCalledWith(
            '[agy] using the stream-json transport: agy 1.4.12 predates agy acp (1.5.0)'
        )
        expect(state.events).toEqual([{
            type: 'message',
            message: 'Antigravity runs without agy acp (agy 1.4.12 predates agy acp (1.5.0)); Steer is not available.'
        }])
    })

    it('falls back to stream-json when agy acp fails to start', async () => {
        fakeAgy('echo 1.5.2')
        harness.acpError = new AgyAcpStartError('Failed to start agy acp (requires Antigravity CLI 1.5.0 or newer): boom')
        const { session, state } = fakeSession({})

        await agyRemoteLauncher(session as never)

        expect(harness.acpLaunches).toBe(1)
        expect(harness.streamJsonLaunches).toBe(1)
        expect(state.events).toEqual([{
            type: 'message',
            message: 'Antigravity runs without agy acp (agy acp failed to start: Failed to start agy acp (requires Antigravity CLI 1.5.0 or newer): boom); Steer is not available.'
        }])
    })

    it('does not fall back for errors after agy acp started', async () => {
        fakeAgy('echo 1.5.2')
        harness.acpError = new Error('connection lost')
        const { session } = fakeSession({})

        await expect(agyRemoteLauncher(session as never)).rejects.toThrow('connection lost')
        expect(harness.streamJsonLaunches).toBe(0)
    })

    it('reads the version from stdout, not from notices on stderr', async () => {
        fakeAgy('echo "update 1.5.3 available" >&2; echo 1.4.12')
        const { session } = fakeSession({})

        await agyRemoteLauncher(session as never)

        expect(harness.streamJsonLaunches).toBe(1)
        expect(harness.acpLaunches).toBe(0)
    })

    it('falls back to stream-json and says why when the version check fails', async () => {
        fakeAgy('echo "not signed in" >&2; exit 3')
        const { session } = fakeSession({})

        await agyRemoteLauncher(session as never)

        expect(harness.streamJsonLaunches).toBe(1)
        expect(harness.acpLaunches).toBe(0)
        expect(harness.warn).toHaveBeenCalledWith(
            '[agy] using the stream-json transport: could not read the agy version (agy --version exited with code 3)'
        )
    })
})

describe('probeAgyVersion', () => {
    let dir: string
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agy-probe-')) })
    afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

    function script(body: string): string {
        const path = join(dir, 'agy')
        writeFileSync(path, `#!/bin/sh\n${body}\n`)
        chmodSync(path, 0o755)
        return path
    }

    it('reports a missing agy binary', async () => {
        await expect(probeAgyVersion(join(dir, 'missing-agy'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await needsStreamJson(() => probeAgyVersion(join(dir, 'missing-agy')))).toMatchObject({ streamJson: true })
    })

    it('gives up on an agy that never answers', async () => {
        const choice = await needsStreamJson(() => probeAgyVersion(script('sleep 5'), 200))
        expect(choice).toEqual({ streamJson: true, reason: 'could not read the agy version (agy --version did not answer within 200 ms)' })
    })

    it('does not wait for a background child that keeps stdout open', async () => {
        const started = Date.now()
        const output = await probeAgyVersion(script('(sleep 3 &); echo 1.5.2'), 5000)
        expect(output.trim()).toBe('1.5.2')
        expect(Date.now() - started).toBeLessThan(2500)
    })
})
