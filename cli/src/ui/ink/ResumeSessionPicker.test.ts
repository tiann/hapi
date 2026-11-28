import React, { act } from 'react'
import { PassThrough } from 'node:stream'
import { render, type Instance } from 'ink'
import { expect, it, vi } from 'vitest'
import type { ResumableSession } from '@hapi/protocol'
import { ResumeSessionPicker } from './ResumeSessionPicker'

it.each([80, 40])('keeps wide titles on one row and shows the selected ID at %i columns', async (columns) => {
    const base: ResumableSession = {
        sessionId: 'session-one', flavor: 'claude', directory: '/work/app', machineId: 'machine',
        active: false, thinking: false, controlledByUser: false, agentSessionId: 'agent-one', updatedAt: Date.now()
    }
    const sessions = [
        base,
        { ...base, sessionId: 'session-two' },
        { ...base, sessionId: 'session-three', name: 'a'.repeat(47) + '\u231a' }
    ]
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns, rows: 12 })
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() })
    let output = ''
    stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    let instance: Instance | undefined
    try {
        await act(async () => {
            instance = render(React.createElement(ResumeSessionPicker, { sessions, onCancel: vi.fn(), onSelect: vi.fn() }), {
                stdout: stdout as unknown as NodeJS.WriteStream,
                stdin: stdin as unknown as NodeJS.ReadStream,
                debug: true,
                patchConsole: false
            })
        })
        expect(output).toContain('ID: session-one')
        expect(output).toMatch(/inactive +a+\u2026\n/)
        expect(output.trimEnd().split('\n')).toHaveLength(stdout.rows)
        output = ''
        await act(async () => { stdin.write('\x1b[B') })
        expect(output).toContain('ID: session-two')
    } finally {
        await act(async () => { instance?.unmount() })
        vi.unstubAllGlobals()
    }
})
