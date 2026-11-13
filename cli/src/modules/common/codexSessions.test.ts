import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
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
})

type CodexTranscriptLine = Record<string, unknown>

function sessionMetaLine(sessionId: string): CodexTranscriptLine {
    return {
        type: 'session_meta',
        payload: {
            id: sessionId,
            cwd: '/tmp/project',
            originator: 'codex_cli_rs',
            cli_version: '0.0.0-test'
        }
    }
}

function responseUserLine(text: string): CodexTranscriptLine {
    return {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
    }
}

function responseAssistantLine(text: string): CodexTranscriptLine {
    return {
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
    }
}

function eventUserLine(text: string): CodexTranscriptLine {
    return { type: 'event_msg', payload: { type: 'user_message', message: text } }
}

function eventAgentLine(text: string): CodexTranscriptLine {
    return { type: 'event_msg', payload: { type: 'agent_message', message: text } }
}

describe('Codex transcript import parity', () => {
    const originalCodexHome = process.env.CODEX_HOME
    let codexHome = ''

    afterEach(() => {
        if (originalCodexHome === undefined) delete process.env.CODEX_HOME
        else process.env.CODEX_HOME = originalCodexHome
        if (codexHome) rmSync(codexHome, { recursive: true, force: true })
        codexHome = ''
    })

    function writeTranscript(name: string, sessionId: string, lines: CodexTranscriptLine[]): void {
        const dir = join(codexHome, 'sessions', '2026', '06', '04')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, name), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf-8')
    }

    function importMessages(sessionId: string) {
        const sessions = listLocalCodexSessionsWithMessagesByIds(new Set([sessionId]))
        const session = sessions.find((item) => item.id === sessionId)
        if (!session) throw new Error(`Codex session ${sessionId} was not found`)
        return session.messages
    }

    function useCodexHome(): string {
        codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'))
        process.env.CODEX_HOME = codexHome
        return codexHome
    }

    it('imports normal response_item chat messages', () => {
        useCodexHome()
        writeTranscript('normal.jsonl', 'normal-session-id', [
            sessionMetaLine('normal-session-id'),
            responseUserLine('normal user message'),
            responseAssistantLine('normal assistant message')
        ])

        const messages = importMessages('normal-session-id')

        expect(messages).toHaveLength(2)
        expect(messages[0]).toEqual({
            role: 'user',
            content: { type: 'text', text: 'normal user message' },
            meta: { sentFrom: 'cli' }
        })
        expect(messages[1]).toEqual({
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: { type: 'message', message: 'normal assistant message', id: expect.any(String) }
            },
            meta: { sentFrom: 'cli' }
        })
    })

    it('deduplicates mirrored event_msg and response_item user messages', () => {
        useCodexHome()
        writeTranscript('mirrored.jsonl', 'mirrored-session-id', [
            sessionMetaLine('mirrored-session-id'),
            eventUserLine('mirrored user message'),
            responseUserLine('mirrored user message\n')
        ])

        const messages = importMessages('mirrored-session-id')

        expect(messages).toHaveLength(1)
        expect(messages[0]).toEqual({
            role: 'user',
            content: { type: 'text', text: 'mirrored user message' },
            meta: { sentFrom: 'cli' }
        })
    })

    it('deduplicates adjacent mirrored agent messages with different ids', () => {
        useCodexHome()
        writeTranscript('mirrored-agent.jsonl', 'mirrored-agent-session-id', [
            sessionMetaLine('mirrored-agent-session-id'),
            eventAgentLine('duplicated assistant message'),
            responseAssistantLine('duplicated assistant message')
        ])

        const messages = importMessages('mirrored-agent-session-id')

        expect(messages).toHaveLength(1)
        expect(messages[0]).toEqual({
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: { type: 'message', message: 'duplicated assistant message', id: expect.any(String) }
            },
            meta: { sentFrom: 'cli' }
        })
    })

    it('skips injected response_item user context messages', () => {
        useCodexHome()
        writeTranscript('injected.jsonl', 'injected-session-id', [
            sessionMetaLine('injected-session-id'),
            responseUserLine('# AGENTS.md instructions for /repo\n<INSTRUCTIONS>ignore</INSTRUCTIONS>'),
            responseUserLine('<environment_context>\n<current_date>2026-07-07</current_date>\n<filesystem>workspace</filesystem>\n</environment_context>'),
            eventUserLine('real event user message')
        ])

        const messages = importMessages('injected-session-id')

        expect(messages).toHaveLength(1)
        expect(messages[0]).toEqual({
            role: 'user',
            content: { type: 'text', text: 'real event user message' },
            meta: { sentFrom: 'cli' }
        })
    })

    it('preserves a real response_item user prompt containing embedded environment_context text', () => {
        useCodexHome()
        writeTranscript('embedded-env.jsonl', 'embedded-env-session-id', [
            sessionMetaLine('embedded-env-session-id'),
            responseUserLine('Please inspect this transcript block:\n<environment_context>\n<current_date>2026-07-07</current_date>\n</environment_context>\nThis is part of my prompt.')
        ])

        const messages = importMessages('embedded-env-session-id')

        expect(messages).toHaveLength(1)
        expect(messages[0]).toMatchObject({
            role: 'user',
            content: { type: 'text', text: expect.stringContaining('<environment_context>') }
        })
    })

    it('preserves adjacent duplicate messages from the same transcript source', () => {
        useCodexHome()
        writeTranscript('same-source.jsonl', 'same-source-session-id', [
            sessionMetaLine('same-source-session-id'),
            responseUserLine('same source user message'),
            responseUserLine('same source user message'),
            responseAssistantLine('same source assistant message'),
            responseAssistantLine('same source assistant message')
        ])

        const messages = importMessages('same-source-session-id')

        expect(messages).toHaveLength(4)
        expect(messages.map((message) => message.role)).toEqual(['user', 'user', 'agent', 'agent'])
    })

    it('keeps a later response_item-only user turn with the same text', () => {
        useCodexHome()
        writeTranscript('repeat-user.jsonl', 'repeat-user-session-id', [
            sessionMetaLine('repeat-user-session-id'),
            eventUserLine('repeat user message'),
            responseUserLine('repeat user message'),
            responseAssistantLine('assistant answer'),
            responseUserLine('repeat user message')
        ])

        const messages = importMessages('repeat-user-session-id')

        expect(messages.map((message) => message.role)).toEqual(['user', 'agent', 'user'])
        expect(messages[0]).toMatchObject({
            role: 'user',
            content: { type: 'text', text: 'repeat user message' }
        })
        expect(messages[2]).toMatchObject({
            role: 'user',
            content: { type: 'text', text: 'repeat user message' }
        })
    })

    it('keeps distinct user turns while deduplicating mirrored user events', () => {
        useCodexHome()
        writeTranscript('distinct-user.jsonl', 'distinct-user-session-id', [
            sessionMetaLine('distinct-user-session-id'),
            eventUserLine('first user message'),
            responseUserLine('first user message'),
            eventUserLine('second user message')
        ])

        const messages = importMessages('distinct-user-session-id')

        expect(messages).toHaveLength(2)
        expect(messages.map((message) => message.content)).toEqual([
            { type: 'text', text: 'first user message' },
            { type: 'text', text: 'second user message' }
        ])
    })

    it('uses the latest session_index thread_name for the session title', () => {
        useCodexHome()
        writeTranscript('index-title.jsonl', 'index-title-session-id', [
            sessionMetaLine('index-title-session-id'),
            responseUserLine('normal user message')
        ])
        writeFileSync(join(codexHome, 'session_index.jsonl'), [
            JSON.stringify({ id: 'index-title-session-id', thread_name: 'old thread title', updated_at: '2026-07-07T01:00:00.000000000Z' }),
            JSON.stringify({ id: 'index-title-session-id', thread_name: 'new thread title', updated_at: '2026-07-07T02:00:00.000000000Z' })
        ].join('\n'))

        expect(listLocalCodexSessionSummaries()[0]?.title).toBe('new thread title')
    })

    it('falls back to the transcript title when session_index is missing', () => {
        useCodexHome()
        writeTranscript('no-index-title.jsonl', 'no-index-title-session-id', [
            sessionMetaLine('no-index-title-session-id'),
            responseUserLine('normal user message')
        ])

        expect(listLocalCodexSessionSummaries()[0]?.title).toBe('normal user message')
    })

    it('falls back to the transcript title when session_index has no matching id', () => {
        useCodexHome()
        writeTranscript('index-miss-title.jsonl', 'index-miss-title-session-id', [
            sessionMetaLine('index-miss-title-session-id'),
            responseUserLine('normal user message')
        ])
        writeFileSync(join(codexHome, 'session_index.jsonl'), [
            JSON.stringify({ id: 'other-session-id', thread_name: 'unrelated title', updated_at: '2026-07-07T03:00:00.000000000Z' })
        ].join('\n'))

        expect(listLocalCodexSessionSummaries()[0]?.title).toBe('normal user message')
    })

    it('keeps event_msg user messages that only look like injected context', () => {
        useCodexHome()
        writeTranscript('event-injected.jsonl', 'event-injected-session-id', [
            sessionMetaLine('event-injected-session-id'),
            eventUserLine('# AGENTS.md instructions for /repo')
        ])

        const messages = importMessages('event-injected-session-id')

        expect(messages).toHaveLength(1)
        expect(messages[0]).toEqual({
            role: 'user',
            content: { type: 'text', text: '# AGENTS.md instructions for /repo' },
            meta: { sentFrom: 'cli' }
        })
    })

    it('keeps a response_item user prompt with an unclosed environment_context block', () => {
        useCodexHome()
        writeTranscript('unclosed-env.jsonl', 'unclosed-env-session-id', [
            sessionMetaLine('unclosed-env-session-id'),
            responseUserLine('<environment_context>\n<current_date>2026-07-07</current_date>')
        ])

        const messages = importMessages('unclosed-env-session-id')

        expect(messages).toHaveLength(1)
        expect(messages[0]).toMatchObject({
            role: 'user',
            content: { type: 'text', text: expect.stringContaining('<environment_context>') }
        })
    })
})
