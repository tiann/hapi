import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalResumeTarget, LocalResumeTargetByAgentResponse, ResumableSession } from '@hapi/protocol'
import {
    findLatestClaudeTranscriptId,
    parseClaudeResumeArgs,
    resolveClaudeResume,
    type ClaudeResumeDeps
} from './resumeIdentity'
import { getProjectPath } from './utils/path'

const ID_A = '2a9e1ab6-4458-468e-9ad1-2f1b4d856bb2'
const ID_B = '7e6b91b1-d91e-4a32-9ac6-d16b2e354a4a'

describe('parseClaudeResumeArgs', () => {
    it.each([
        [['-r', ID_A], ID_A],
        [['--resume', ID_A], ID_A],
        [[`--resume=${ID_A}`], ID_A]
    ])('treats %j as an explicit resume', (args, id) => {
        expect(parseClaudeResumeArgs(args)).toEqual({
            request: { kind: 'explicit', agentSessionId: id },
            remainingArgs: []
        })
    })

    it.each([[['-r']], [['--resume']], [['--resume', 'channel design']], [['-r', '--model', 'opus']]])(
        'treats %j as the picker and keeps unrelated args',
        (args) => {
            const parsed = parseClaudeResumeArgs(args)
            expect(parsed.request).toEqual({ kind: 'picker' })
            expect(parsed.remainingArgs).toEqual(args.includes('--model') ? ['--model', 'opus'] : [])
        }
    )

    it('treats -c/--continue as a flag and keeps a following prompt', () => {
        expect(parseClaudeResumeArgs(['-c', 'keep going'])).toEqual({
            request: { kind: 'continue' },
            remainingArgs: ['keep going']
        })
        expect(parseClaudeResumeArgs(['--continue']).request).toEqual({ kind: 'continue' })
    })

    it('leaves fork requests and plain args untouched', () => {
        expect(parseClaudeResumeArgs(['--resume', ID_A, '--fork-session'])).toEqual({
            request: null,
            remainingArgs: ['--resume', ID_A, '--fork-session']
        })
        expect(parseClaudeResumeArgs(['--verbose'])).toEqual({ request: null, remainingArgs: ['--verbose'] })
    })

    it('does not read flags after --', () => {
        expect(parseClaudeResumeArgs(['--', '-r', ID_A])).toEqual({ request: null, remainingArgs: ['--', '-r', ID_A] })
    })
})

describe('findLatestClaudeTranscriptId', () => {
    let configDir: string
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

    beforeEach(() => {
        configDir = mkdtempSync(join(tmpdir(), 'hapi-claude-config-'))
        process.env.CLAUDE_CONFIG_DIR = configDir
    })

    afterEach(() => {
        if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
        rmSync(configDir, { recursive: true, force: true })
    })

    function writeTranscript(cwd: string, id: string, mtimeSeconds: number, hasMessage = true) {
        const dir = getProjectPath(cwd)
        mkdirSync(dir, { recursive: true })
        const file = join(dir, `${id}.jsonl`)
        writeFileSync(file, hasMessage ? `${JSON.stringify({ uuid: 'm1', type: 'user' })}\n` : '{"type":"summary"}\n')
        utimesSync(file, mtimeSeconds, mtimeSeconds)
    }

    it('returns the newest transcript that has messages', () => {
        writeTranscript('/work/project', ID_A, 1_000)
        writeTranscript('/work/project', ID_B, 2_000, false)

        expect(findLatestClaudeTranscriptId('/work/project')).toBe(ID_A)
    })

    it('returns null when the project has no transcripts', () => {
        expect(findLatestClaudeTranscriptId('/work/empty')).toBeNull()
    })
})

function target(overrides: Partial<LocalResumeTarget> = {}): LocalResumeTarget {
    return {
        sessionId: 'hapi-1',
        flavor: 'claude',
        directory: '/work/project',
        machineId: 'machine-1',
        active: false,
        thinking: false,
        controlledByUser: false,
        agentSessionId: ID_B,
        ...overrides
    }
}

function resumable(overrides: Partial<ResumableSession>): ResumableSession {
    return { ...target(), updatedAt: 1, ...overrides }
}

function deps(overrides: Partial<ClaudeResumeDeps> = {}) {
    const api = {
        getLocalResumeTargetByAgentSessionId: vi.fn(
            async (_agentSessionId: string, _machineId?: string): Promise<LocalResumeTargetByAgentResponse> =>
                ({ target: null, historical: false })
        ),
        listResumableSessions: vi.fn(async () => [] as ResumableSession[]),
        getLocalResumeTarget: vi.fn(async (sessionId: string) => target({ sessionId }))
    }
    const selectSession = vi.fn(async (sessions: ResumableSession[]) => sessions[0]!.sessionId)
    return {
        api,
        selectSession,
        deps: {
            api,
            machineId: 'machine-1',
            workingDirectory: '/work/project',
            isTTY: true,
            selectSession,
            ...overrides
        } satisfies ClaudeResumeDeps
    }
}

describe('resolveClaudeResume', () => {
    it('reopens the HAPI session that owns an explicit Claude id', async () => {
        const { api, deps: d } = deps()
        api.getLocalResumeTargetByAgentSessionId.mockResolvedValue({ target: target({ agentSessionId: ID_A }), historical: false })

        await expect(resolveClaudeResume({ kind: 'explicit', agentSessionId: ID_A }, d))
            .resolves.toEqual({ kind: 'reopen', target: target({ agentSessionId: ID_A }) })
        expect(api.getLocalResumeTargetByAgentSessionId).toHaveBeenCalledWith(ID_A, 'machine-1')
    })

    it('explains when an older Claude id maps to the current conversation', async () => {
        const { api, deps: d } = deps()
        api.getLocalResumeTargetByAgentSessionId.mockResolvedValue({ target: target(), historical: true })

        const resolution = await resolveClaudeResume({ kind: 'explicit', agentSessionId: ID_A }, d)

        expect(resolution).toMatchObject({ kind: 'reopen', target: { agentSessionId: ID_B } })
        expect(resolution.kind === 'reopen' && resolution.notice).toContain(ID_B)
    })

    it('passes through when no HAPI session owns the Claude id', async () => {
        const { deps: d } = deps()

        await expect(resolveClaudeResume({ kind: 'explicit', agentSessionId: ID_A }, d))
            .resolves.toEqual({ kind: 'passthrough' })
    })

    it('resolves --continue through the newest local transcript', async () => {
        const { api, deps: d } = deps({ findLatestTranscriptId: () => ID_A })
        api.getLocalResumeTargetByAgentSessionId.mockResolvedValue({ target: target(), historical: false })

        await expect(resolveClaudeResume({ kind: 'continue' }, d)).resolves.toMatchObject({ kind: 'reopen' })
        expect(api.getLocalResumeTargetByAgentSessionId).toHaveBeenCalledWith(ID_A, 'machine-1')
    })

    it('passes --continue through when there is no transcript', async () => {
        const { api, deps: d } = deps({ findLatestTranscriptId: () => null })

        await expect(resolveClaudeResume({ kind: 'continue' }, d)).resolves.toEqual({ kind: 'passthrough' })
        expect(api.getLocalResumeTargetByAgentSessionId).not.toHaveBeenCalled()
    })

    it('offers only Claude sessions, current directory first, in the picker', async () => {
        const { api, selectSession, deps: d } = deps()
        api.listResumableSessions.mockResolvedValue([
            resumable({ sessionId: 'codex', flavor: 'codex', updatedAt: 9 }),
            resumable({ sessionId: 'elsewhere', directory: '/work/other', updatedAt: 8 }),
            resumable({ sessionId: 'here-old', updatedAt: 1 }),
            resumable({ sessionId: 'here-new', updatedAt: 5 })
        ])

        const resolution = await resolveClaudeResume({ kind: 'picker' }, d)

        expect(selectSession.mock.calls[0]![0].map((s) => s.sessionId)).toEqual(['here-new', 'here-old', 'elsewhere'])
        expect(api.getLocalResumeTarget).toHaveBeenCalledWith('here-new')
        expect(resolution).toMatchObject({ kind: 'reopen', target: { sessionId: 'here-new' } })
    })

    it("falls back to Claude's picker when HAPI knows no Claude sessions", async () => {
        const { api, selectSession, deps: d } = deps()
        api.listResumableSessions.mockResolvedValue([resumable({ flavor: 'codex' })])

        await expect(resolveClaudeResume({ kind: 'picker' }, d)).resolves.toEqual({ kind: 'passthrough' })
        expect(selectSession).not.toHaveBeenCalled()
    })

    it('asks for an explicit id instead of opening the picker without a TTY', async () => {
        const { api, deps: d } = deps({ isTTY: false })
        api.listResumableSessions.mockResolvedValue([resumable({})])

        await expect(resolveClaudeResume({ kind: 'picker' }, d)).rejects.toThrow('hapi claude --resume <claude-session-id>')
    })
})
