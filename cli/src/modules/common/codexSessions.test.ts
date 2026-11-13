import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { archiveLocalCodexSession, listLocalCodexSessionSummaries, listLocalCodexSessionsWithMessagesByIds } from './codexSessions'

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

describe('archiveLocalCodexSession', () => {
    const originalCodexHome = process.env.CODEX_HOME

    afterEach(() => {
        if (originalCodexHome === undefined) delete process.env.CODEX_HOME
        else process.env.CODEX_HOME = originalCodexHome
    })

    it('moves a local codex transcript into archived_sessions preserving relative path', async () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-home-'))
        process.env.CODEX_HOME = root
        const sessionFile = join(root, 'sessions', '2026', '06', '27', 'rollout-2026-06-27T12-00-00-12345678-1234-1234-1234-123456789abc.jsonl')
        mkdirSync(join(root, 'sessions', '2026', '06', '27'), { recursive: true })
        writeFileSync(sessionFile, [
            JSON.stringify({ type: 'session_meta', payload: { id: '12345678-1234-1234-1234-123456789abc', cwd: '/tmp/project' } }),
            JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } })
        ].join('\n'))

        const sessions = listLocalCodexSessionSummaries()
        expect(sessions).toHaveLength(1)
        expect(sessions[0]?.id).toBe('12345678-1234-1234-1234-123456789abc')

        const result = await archiveLocalCodexSession('12345678-1234-1234-1234-123456789abc')
        expect(result.success).toBe(true)
        if (!result.success) return
        expect(existsSync(sessionFile)).toBe(false)
        expect(existsSync(result.archivedPath)).toBe(true)
        expect(readFileSync(result.archivedPath, 'utf-8')).toContain('session_meta')

        rmSync(root, { recursive: true, force: true })
    })

    it('refuses to archive when the caller denies the session', async () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-home-'))
        process.env.CODEX_HOME = root
        const sessionFile = join(root, 'sessions', '2026', '06', '27', 'outside.jsonl')
        mkdirSync(join(root, 'sessions', '2026', '06', '27'), { recursive: true })
        writeFileSync(sessionFile, [
            JSON.stringify({ type: 'session_meta', payload: { id: 'outside-session-id', cwd: '/tmp/outside' } }),
            JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'outside' }] } })
        ].join('\n'))

        const result = await archiveLocalCodexSession('outside-session-id', { canArchive: () => false })

        expect(result).toEqual({ success: false, error: 'Codex session is outside workspace roots' })
        expect(existsSync(sessionFile)).toBe(true)

        rmSync(root, { recursive: true, force: true })
    })
})

describe('listLocalCodexSessionSummaries', () => {
    const originalCodexHome = process.env.CODEX_HOME

    afterEach(() => {
        if (originalCodexHome === undefined) delete process.env.CODEX_HOME
        else process.env.CODEX_HOME = originalCodexHome
    })

    it('parses original and fork metadata from session_meta', () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-home-'))
        process.env.CODEX_HOME = root
        const sessionsDir = join(root, 'sessions', '2026', '06', '27')
        mkdirSync(sessionsDir, { recursive: true })

        writeFileSync(join(sessionsDir, 'original.jsonl'), [
            JSON.stringify({
                type: 'session_meta',
                payload: {
                    id: 'original-session-id',
                    cwd: '/tmp/project',
                    originator: 'Codex Desktop',
                    cli_version: '0.142.2',
                    source: 'vscode',
                    thread_source: 'user'
                }
            }),
            JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } })
        ].join('\n'))

        writeFileSync(join(sessionsDir, 'fork.jsonl'), [
            JSON.stringify({
                type: 'session_meta',
                payload: {
                    id: 'fork-session-id',
                    cwd: '/tmp/project',
                    originator: 'hapi-codex-client',
                    cli_version: '0.142.3',
                    source: 'vscode',
                    forked_from_id: 'original-session-id'
                }
            }),
            JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fork hello' }] } })
        ].join('\n'))

        const sessions = listLocalCodexSessionSummaries()
        const original = sessions.find((session) => session.id === 'original-session-id')
        const fork = sessions.find((session) => session.id === 'fork-session-id')

        expect(original).toMatchObject({
            source: 'vscode',
            threadSource: 'user',
            forkedFromId: null
        })
        expect(fork).toMatchObject({
            source: 'vscode',
            threadSource: null,
            forkedFromId: 'original-session-id'
        })

        rmSync(root, { recursive: true, force: true })
    })

    it('uses the latest session_index thread name as the title', () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-home-'))
        process.env.CODEX_HOME = root
        const sessionsDir = join(root, 'sessions', '2026', '07', '19')
        mkdirSync(sessionsDir, { recursive: true })

        writeFileSync(join(sessionsDir, 'session.jsonl'), [
            JSON.stringify({ type: 'session_meta', payload: { id: 'indexed-session-id', cwd: '/tmp/project' } }),
            JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fallback title' }] } })
        ].join('\n'))
        writeFileSync(join(root, 'session_index.jsonl'), [
            JSON.stringify({ id: 'indexed-session-id', thread_name: 'old title', updated_at: '2026-07-19T01:00:00Z' }),
            JSON.stringify({ id: 'indexed-session-id', thread_name: 'latest title', updated_at: '2026-07-19T02:00:00Z' })
        ].join('\n'))

        expect(listLocalCodexSessionSummaries()[0]?.title).toBe('latest title')
        rmSync(root, { recursive: true, force: true })
    })

    it('skips subagent transcripts', () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-home-'))
        process.env.CODEX_HOME = root
        const sessionsDir = join(root, 'sessions', '2026', '06', '27')
        mkdirSync(sessionsDir, { recursive: true })

        writeFileSync(join(sessionsDir, 'subagent.jsonl'), [
            JSON.stringify({
                type: 'session_meta',
                payload: {
                    id: 'subagent-session-id',
                    cwd: '/tmp/project',
                    source: { subagent: 'worker' }
                }
            }),
            JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hidden' }] } })
        ].join('\n'))

        expect(listLocalCodexSessionSummaries()).toHaveLength(0)

        rmSync(root, { recursive: true, force: true })
    })

    it('loads messages only for requested session ids', () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-home-'))
        process.env.CODEX_HOME = root
        const sessionsDir = join(root, 'sessions', '2026', '06', '27')
        mkdirSync(sessionsDir, { recursive: true })

        writeFileSync(join(sessionsDir, 'wanted.jsonl'), [
            JSON.stringify({ type: 'session_meta', payload: { id: 'wanted-session-id', cwd: '/tmp/project' } }),
            JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'wanted' }] } })
        ].join('\n'))
        writeFileSync(join(sessionsDir, 'other.jsonl'), [
            JSON.stringify({ type: 'session_meta', payload: { id: 'other-session-id', cwd: '/tmp/project' } }),
            JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'other' }] } })
        ].join('\n'))

        const sessions = listLocalCodexSessionsWithMessagesByIds(new Set(['wanted-session-id']))

        expect(sessions.map((session) => session.id)).toEqual(['wanted-session-id'])
        expect(sessions[0]?.messages).toHaveLength(1)
        rmSync(root, { recursive: true, force: true })
    })

    it('selects the latest matching session without mistaking child transcripts for it', () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-home-'))
        process.env.CODEX_HOME = root
        const dir = join(root, 'sessions')
        mkdirSync(dir, { recursive: true })
        const make = (name: string, source: unknown, text: string, seconds: number) => {
            const path = join(dir, name)
            writeFileSync(path, [
                JSON.stringify({ type: 'session_meta', payload: { id: 'wanted', cwd: '/tmp/project', source } }),
                JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
            ].join('\n'))
            utimesSync(path, seconds, seconds)
        }
        make('old.jsonl', 'cli', 'old', 100)
        make('new.jsonl', 'cli', 'new', 200)
        make('child.jsonl', { subagent: 'worker' }, 'child', 300)
        const sessions = listLocalCodexSessionsWithMessagesByIds(new Set(['wanted']))
        expect(sessions).toHaveLength(1)
        expect(sessions[0]?.file).toBe(join(dir, 'new.jsonl'))
        expect(JSON.stringify(sessions[0]?.messages)).toContain('new')
        rmSync(root, { recursive: true, force: true })
    })

    it('does not fully read unrelated large session files', () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-home-'))
        process.env.CODEX_HOME = root
        const dir = join(root, 'sessions')
        mkdirSync(dir, { recursive: true })
        const wanted = join(dir, 'wanted.jsonl')
        const unrelated = join(dir, 'unrelated.jsonl')
        writeFileSync(wanted, JSON.stringify({ type: 'session_meta', payload: { id: 'wanted' } }) + '\n')
        writeFileSync(unrelated, JSON.stringify({ type: 'session_meta', payload: { id: 'unrelated' } }) + '\n' + 'x'.repeat(2 * 1024 * 1024))
        const spy = vi.mocked(readFileSync)
        spy.mockClear()
        try {
            expect(listLocalCodexSessionsWithMessagesByIds(new Set(['wanted'])).map(session => session.id)).toEqual(['wanted'])
            expect(spy.mock.calls.some(call => call[0] === unrelated)).toBe(false)
        } finally {
            spy.mockClear()
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('includes inherited history from nested paginated fork ancestors', () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-home-'))
        process.env.CODEX_HOME = root
        const sessionsDir = join(root, 'sessions', '2026', '06', '27')
        const archivedDir = join(root, 'archived_sessions', '2026', '06', '26')
        mkdirSync(sessionsDir, { recursive: true })
        mkdirSync(archivedDir, { recursive: true })
        const rootId = '11111111-1111-1111-1111-111111111111'
        const parentId = '22222222-2222-2222-2222-222222222222'
        const childId = '33333333-3333-3333-3333-333333333333'
        const user = (ordinal: number, text: string) => JSON.stringify({
            ordinal,
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
        })
        const meta = (ordinal: number, id: string, base?: { thread_id: string; end_ordinal_exclusive: number }) => JSON.stringify({
            ordinal,
            type: 'session_meta',
            payload: { id, cwd: '/tmp/project', history_mode: 'paginated', ...(base ? { forked_from_id: base.thread_id, forked_from_ordinal_exclusive: base.end_ordinal_exclusive, history_base: base } : {}) }
        })

        writeFileSync(join(archivedDir, `rollout-2026-06-26T10-00-00-${rootId}.jsonl.zst`), zstdCompressSync([
            meta(0, rootId), user(1, 'root one'), user(2, 'root two'), user(3, 'root after fork')
        ].join('\n')))
        writeFileSync(join(archivedDir, `rollout-2026-06-26T11-00-00-${parentId}.jsonl`), [
            meta(3, parentId, { thread_id: rootId, end_ordinal_exclusive: 3 }), user(4, 'parent one'), user(5, 'parent after fork')
        ].join('\n'))
        writeFileSync(join(sessionsDir, `rollout-2026-06-27T12-00-00-${childId}.jsonl`), [
            meta(5, childId, { thread_id: parentId, end_ordinal_exclusive: 5 }), user(6, 'child one')
        ].join('\n'))

        const sessions = listLocalCodexSessionsWithMessagesByIds(new Set([childId]))

        expect(sessions[0]?.messages.map((message) => (message.content as { text?: string }).text)).toEqual([
            'root one', 'root two', 'parent one', 'child one'
        ])
        rmSync(root, { recursive: true, force: true })
    })

    it('refuses to load a fork whose ancestor rollout is missing', () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-home-'))
        process.env.CODEX_HOME = root
        const sessionsDir = join(root, 'sessions', '2026', '06', '27')
        mkdirSync(sessionsDir, { recursive: true })
        const missingId = '44444444-4444-4444-4444-444444444444'
        writeFileSync(join(sessionsDir, 'fork.jsonl'), [
            JSON.stringify({ ordinal: 2, type: 'session_meta', payload: { id: 'fork-session-id', cwd: '/tmp/project', history_base: { thread_id: missingId, end_ordinal_exclusive: 2 } } }),
            JSON.stringify({ ordinal: 3, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'later' }] } })
        ].join('\n'))

        expect(() => listLocalCodexSessionsWithMessagesByIds(new Set(['fork-session-id']))).toThrow(missingId)
        rmSync(root, { recursive: true, force: true })
    })

    it('refuses to load a fork whose ancestor rollout is truncated or has gaps', () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-home-'))
        process.env.CODEX_HOME = root
        const sessionsDir = join(root, 'sessions', '2026', '06', '27')
        mkdirSync(sessionsDir, { recursive: true })
        const parentId = '55555555-5555-5555-5555-555555555555'
        writeFileSync(join(sessionsDir, `rollout-2026-06-27T11-00-00-${parentId}.jsonl`), [
            JSON.stringify({ ordinal: 0, type: 'session_meta', payload: { id: parentId, cwd: '/tmp/project' } })
        ].join('\n'))
        writeFileSync(join(sessionsDir, 'fork.jsonl'), [
            JSON.stringify({ ordinal: 3, type: 'session_meta', payload: { id: 'fork-session-id', cwd: '/tmp/project', history_base: { thread_id: parentId, end_ordinal_exclusive: 3 } } }),
            JSON.stringify({ ordinal: 4, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'later' }] } })
        ].join('\n'))

        expect(() => listLocalCodexSessionsWithMessagesByIds(new Set(['fork-session-id']))).toThrow('missing records before the fork point')

        writeFileSync(join(sessionsDir, `rollout-2026-06-27T11-00-00-${parentId}.jsonl`), [
            JSON.stringify({ ordinal: 0, type: 'session_meta', payload: { id: parentId, cwd: '/tmp/project' } }),
            JSON.stringify({ ordinal: 2, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'gap before me' }] } })
        ].join('\n'))
        expect(() => listLocalCodexSessionsWithMessagesByIds(new Set(['fork-session-id']))).toThrow('missing records before the fork point')
        rmSync(root, { recursive: true, force: true })
    })
})
