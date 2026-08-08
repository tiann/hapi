import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '../sync/syncEngine'
import {
    DEFAULT_COPY,
    buildPermissionRequestCopy,
    buildReadyCopy,
    buildSessionCompletionCopy,
    buildTaskCopy,
    isTaskFailure,
    loadNotificationCopy,
    renderTemplate,
    resolveCopy
} from './notificationCopy'

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        active: true,
        metadata: { name: 'Demo task', flavor: 'codex' },
        ...overrides
    } as Session
}

describe('renderTemplate', () => {
    it('replaces known variables and leaves unknown ones as-is', () => {
        expect(renderTemplate('{agentName} in {sessionName} and {typo}', {
            agentName: 'Codex',
            sessionName: 'Demo task'
        })).toBe('Codex in Demo task and {typo}')
    })

    it('handles empty vars', () => {
        expect(renderTemplate('{agentName} hello', {})).toBe('{agentName} hello')
    })
})

describe('loadNotificationCopy', () => {
    it('returns empty config when settings.json is missing', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-copy-test-'))
        try {
            expect(await loadNotificationCopy(dir)).toEqual({})
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('returns stored overrides and ignores other keys', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-copy-test-'))
        try {
            await writeFile(join(dir, 'settings.json'), JSON.stringify({
                cliApiToken: 'abc',
                notificationCopy: {
                    ready: { title: 'Hey!', body: '{agentName} wants you' }
                }
            }))
            expect(await loadNotificationCopy(dir)).toEqual({
                ready: { title: 'Hey!', body: '{agentName} wants you' }
            })
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('returns empty config when persisted copy is malformed', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-copy-test-'))
        try {
            await writeFile(join(dir, 'settings.json'), JSON.stringify({
                notificationCopy: { ready: { title: 42, body: 'hello' } }
            }))
            expect(await loadNotificationCopy(dir)).toEqual({})
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })
})

describe('resolveCopy', () => {
    it('returns the default when no stored template exists', () => {
        expect(resolveCopy('ready', {})).toEqual(DEFAULT_COPY.ready)
    })

    it('falls back only the title when title is empty', () => {
        expect(resolveCopy('ready', { ready: { title: '  ', body: 'custom' } })).toEqual({
            title: DEFAULT_COPY.ready.title,
            body: 'custom'
        })
    })

    it('falls back only the body when body is empty', () => {
        expect(resolveCopy('ready', { ready: { title: 'custom', body: '' } })).toEqual({
            title: 'custom',
            body: DEFAULT_COPY.ready.body
        })
    })

    it('returns the stored template when both fields are non-empty', () => {
        expect(resolveCopy('ready', { ready: { title: 'custom', body: 'hello {agentName}' } }))
            .toEqual({ title: 'custom', body: 'hello {agentName}' })
    })
})

describe('isTaskFailure', () => {
    it('treats failed/error/killed/aborted as failure, case-insensitively', () => {
        for (const status of ['failed', 'error', 'killed', 'aborted', 'FAILED', ' Error ']) {
            expect(isTaskFailure(status)).toBe(true)
        }
    })

    it('treats completed and undefined as success', () => {
        expect(isTaskFailure('completed')).toBe(false)
        expect(isTaskFailure(undefined)).toBe(false)
    })
})

describe('build*Copy', () => {
    it('substitutes variables in permission copy with tool formatting', () => {
        const session = createSession({
            agentState: { requests: { 'r-1': { tool: 'Bash', arguments: {} } } }
        })
        const result = buildPermissionRequestCopy(session, {}, '/sessions/session-1')
        expect(result).toEqual({
            title: 'Permission Request',
            body: 'Demo task (Bash)'
        })
    })

    it('omits tool formatting when no tool is requested', () => {
        const result = buildPermissionRequestCopy(createSession(), {}, '/sessions/session-1')
        expect(result.body).toBe('Demo task')
    })

    it('applies a custom permission template', () => {
        const session = createSession({
            agentState: { requests: { 'r-1': { tool: 'Bash', arguments: {} } } }
        })
        // Note: {tool} includes the leading space + parens (e.g. " (Bash)"),
        // matching the pre-customization body format.
        const result = buildPermissionRequestCopy(session, {
            permissionRequest: { title: '{agentName} needs approval', body: '{sessionName} wants{tool} at {url}' }
        }, '/sessions/session-1')
        expect(result).toEqual({
            title: 'Codex needs approval',
            body: 'Demo task wants (Bash) at /sessions/session-1'
        })
    })

    it('renders ready copy with defaults', () => {
        expect(buildReadyCopy(createSession(), {}, '/sessions/session-1')).toEqual({
            title: 'Ready for input',
            body: 'Codex is waiting in Demo task'
        })
    })

    it('selects taskFailed for failure statuses and renders variables', () => {
        const result = buildTaskCopy(createSession(), { status: 'failed', summary: 'Build broke' }, {}, '/sessions/session-1')
        expect(result.isFailure).toBe(true)
        expect(result.title).toBe('Task failed')
        expect(result.body).toBe('Codex · Demo task · Build broke')
    })

    it('selects taskCompleted for success statuses', () => {
        const result = buildTaskCopy(createSession(), { status: 'completed', summary: 'All green' }, {}, '/sessions/session-1')
        expect(result.isFailure).toBe(false)
        expect(result.title).toBe('Task completed')
        expect(result.body).toBe('Codex · Demo task · All green')
    })

    it('renders session completion copy with reason variable', () => {
        const result = buildSessionCompletionCopy(createSession(), 'completed', {
            sessionCompletion: { title: '{sessionName} finished', body: 'via {reason} — {agentName}' }
        }, '/sessions/session-1')
        expect(result).toEqual({
            title: 'Demo task finished',
            body: 'via completed — Codex'
        })
    })
})
