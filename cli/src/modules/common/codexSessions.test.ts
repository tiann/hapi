import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { archiveLocalCodexSession, listLocalCodexSessionSummaries, listLocalCodexSessionsWithMessagesByIds } from './codexSessions'

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
})
