import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
    archiveLocalCodexSession,
    findCodexSessionFile,
    listLocalCodexSessionSummaries,
    listLocalCodexSessionsWithMessagesByIds
} from './codexSessions'

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

    it('stamps scope_role on imported foreign-thread token_count samples', () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-home-'))
        process.env.CODEX_HOME = root
        const sessionsDir = join(root, 'sessions', '2026', '06', '27')
        mkdirSync(sessionsDir, { recursive: true })

        writeFileSync(join(sessionsDir, 'parent.jsonl'), [
            JSON.stringify({ type: 'session_meta', payload: { id: 'parent-session-id', cwd: '/tmp/project' } }),
            JSON.stringify({
                type: 'event_msg',
                thread_id: 'child-session-id',
                payload: {
                    type: 'token_count',
                    info: {
                        total_token_usage: { total_tokens: 77 },
                        model_context_window: 128000
                    }
                }
            }),
            JSON.stringify({
                type: 'event_msg',
                payload: {
                    type: 'token_count',
                    info: {
                        total_token_usage: { total_tokens: 42000 },
                        model_context_window: 128000
                    }
                }
            })
        ].join('\n'))

        const sessions = listLocalCodexSessionsWithMessagesByIds(new Set(['parent-session-id']))
        expect(sessions).toHaveLength(1)
        const tokenMessages = (sessions[0]?.messages ?? [])
            .filter((message) => message.role === 'agent')
            .map((message) => message.content.data as Record<string, unknown>)
            .filter((data) => data.type === 'token_count')

        expect(tokenMessages).toHaveLength(2)
        expect(tokenMessages[0]).toMatchObject({
            type: 'token_count',
            thread_id: 'child-session-id',
            threadId: 'child-session-id',
            scope_role: 'child',
            scopeRole: 'child',
            info: { total_token_usage: { total_tokens: 77 } }
        })
        expect(tokenMessages[1]).toMatchObject({
            type: 'token_count',
            info: { total_token_usage: { total_tokens: 42000 } }
        })
        expect(tokenMessages[1]).not.toHaveProperty('scope_role')
        expect(tokenMessages[1]).not.toHaveProperty('thread_id')

        rmSync(root, { recursive: true, force: true })
    })

    it('ignores filename UUID hits when session_meta id is not requested', () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-home-'))
        process.env.CODEX_HOME = root
        const sessionsDir = join(root, 'sessions', '2026', '06', '27')
        mkdirSync(sessionsDir, { recursive: true })

        const requestedId = '11111111-2222-3333-4444-555555555555'
        const actualId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        writeFileSync(join(sessionsDir, `${requestedId}.jsonl`), [
            JSON.stringify({ type: 'session_meta', payload: { id: actualId, cwd: '/tmp/project' } }),
            JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'mismatch' }] } })
        ].join('\n'))

        const sessions = listLocalCodexSessionsWithMessagesByIds(new Set([requestedId]))
        expect(sessions).toEqual([])

        rmSync(root, { recursive: true, force: true })
    })

    it('ignores UUIDs in parent directories when matching requested ids by filename', () => {
        const parentUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        const sessionUuid = '11111111-2222-3333-4444-555555555555'
        const root = mkdtempSync(join(tmpdir(), `codex-${parentUuid}-`))
        process.env.CODEX_HOME = root
        const sessionsDir = join(root, 'sessions', '2026', '06', '27')
        mkdirSync(sessionsDir, { recursive: true })

        writeFileSync(join(sessionsDir, `${sessionUuid}.jsonl`), [
            JSON.stringify({ type: 'session_meta', payload: { id: sessionUuid, cwd: '/tmp/project' } }),
            JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'wanted' }] } })
        ].join('\n'))

        const sessions = listLocalCodexSessionsWithMessagesByIds(new Set([sessionUuid]))
        expect(sessions.map((session) => session.id)).toEqual([sessionUuid])
        expect(sessions[0]?.messages).toHaveLength(1)

        rmSync(root, { recursive: true, force: true })
    })

    it('dedupes requested-id matches to the newest transcript by modifiedAt', () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-home-'))
        process.env.CODEX_HOME = root
        const sessionsDir = join(root, 'sessions', '2026', '06', '27')
        mkdirSync(sessionsDir, { recursive: true })

        const older = join(sessionsDir, 'older.jsonl')
        const newer = join(sessionsDir, 'newer.jsonl')
        writeFileSync(older, [
            JSON.stringify({ type: 'session_meta', payload: { id: 'dup-session-id', cwd: '/tmp/old' } }),
            JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'older' }] } })
        ].join('\n'))
        writeFileSync(newer, [
            JSON.stringify({ type: 'session_meta', payload: { id: 'dup-session-id', cwd: '/tmp/new' } }),
            JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'newer' }] } })
        ].join('\n'))
        utimesSync(older, new Date('2026-06-27T10:00:00Z'), new Date('2026-06-27T10:00:00Z'))
        utimesSync(newer, new Date('2026-06-27T12:00:00Z'), new Date('2026-06-27T12:00:00Z'))

        const sessions = listLocalCodexSessionsWithMessagesByIds(new Set(['dup-session-id']))
        expect(sessions).toHaveLength(1)
        expect(sessions[0]?.cwd).toBe('/tmp/new')
        expect(sessions[0]?.file).toBe(newer)

        rmSync(root, { recursive: true, force: true })
    })

    it('reads latest title and last user message from the transcript tail', () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-home-'))
        process.env.CODEX_HOME = root
        const sessionsDir = join(root, 'sessions', '2026', '06', '27')
        mkdirSync(sessionsDir, { recursive: true })

        // Build a transcript larger than the 256 KiB summary head window.
        const fillerLine = JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'x'.repeat(4000) }]
            }
        })
        const lines = [
            JSON.stringify({
                type: 'session_meta',
                payload: { id: 'tail-session-id', cwd: '/tmp/project' }
            }),
            JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'early prompt' }]
                }
            }),
            ...Array.from({ length: 80 }, () => fillerLine),
            JSON.stringify({
                type: 'event_msg',
                payload: {
                    type: 'mcp_tool_call_end',
                    invocation: {
                        tool: 'change_title',
                        arguments: { title: 'tail title' }
                    }
                }
            }),
            JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'latest prompt from the tail' }]
                }
            })
        ]
        const filePath = join(sessionsDir, 'tail.jsonl')
        writeFileSync(filePath, lines.join('\n') + '\n')
        expect(statSync(filePath).size).toBeGreaterThan(256 * 1024)

        const sessions = listLocalCodexSessionSummaries()
        expect(sessions).toHaveLength(1)
        expect(sessions[0]?.title).toBe('tail title')
        expect(sessions[0]?.lastUserMessage).toBe('latest prompt from the tail')

        rmSync(root, { recursive: true, force: true })
    })

    it('finds title and last user message when they sit before a large trailing filler window', () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-home-'))
        process.env.CODEX_HOME = root
        const sessionsDir = join(root, 'sessions', '2026', '06', '27')
        mkdirSync(sessionsDir, { recursive: true })

        const fillerLine = JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'y'.repeat(4000) }]
            }
        })
        // Keep title/user inside the last 256 KiB scan budget (~40 * 4KiB filler).
        const lines = [
            JSON.stringify({
                type: 'session_meta',
                payload: { id: 'middle-session-id', cwd: '/tmp/project' }
            }),
            JSON.stringify({
                type: 'event_msg',
                payload: {
                    type: 'mcp_tool_call_end',
                    invocation: {
                        tool: 'change_title',
                        arguments: { title: 'middle title' }
                    }
                }
            }),
            JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'prompt before long filler' }]
                }
            }),
            ...Array.from({ length: 40 }, () => fillerLine)
        ]
        const filePath = join(sessionsDir, 'middle.jsonl')
        writeFileSync(filePath, lines.join('\n') + '\n')
        expect(statSync(filePath).size).toBeGreaterThan(128 * 1024)
        expect(statSync(filePath).size).toBeLessThanOrEqual(256 * 1024)

        const sessions = listLocalCodexSessionSummaries()
        expect(sessions).toHaveLength(1)
        expect(sessions[0]?.title).toBe('middle title')
        expect(sessions[0]?.lastUserMessage).toBe('prompt before long filler')

        rmSync(root, { recursive: true, force: true })
    })

    it('falls back when change_title sits outside the reverse-scan budget', () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-home-'))
        process.env.CODEX_HOME = root
        const sessionsDir = join(root, 'sessions', '2026', '06', '27')
        mkdirSync(sessionsDir, { recursive: true })

        const fillerLine = JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'y'.repeat(4000) }]
            }
        })
        const lines = [
            JSON.stringify({
                type: 'session_meta',
                payload: { id: 'beyond-budget-id', cwd: '/tmp/project' }
            }),
            JSON.stringify({
                type: 'event_msg',
                payload: {
                    type: 'mcp_tool_call_end',
                    invocation: {
                        tool: 'change_title',
                        arguments: { title: 'beyond budget title' }
                    }
                }
            }),
            JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'early prompt' }]
                }
            }),
            ...Array.from({ length: 80 }, () => fillerLine)
        ]
        const filePath = join(sessionsDir, 'beyond.jsonl')
        writeFileSync(filePath, lines.join('\n') + '\n')
        expect(statSync(filePath).size).toBeGreaterThan(256 * 1024)

        const sessions = listLocalCodexSessionSummaries()
        expect(sessions).toHaveLength(1)
        // Title beyond the 256 KiB budget falls back to the first head user prompt.
        expect(sessions[0]?.title).toBe('early prompt')
        expect(sessions[0]?.lastUserMessage).toBeNull()

        rmSync(root, { recursive: true, force: true })
    })

    it('resolves transcript paths without reverse-scanning titles on large files', () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-home-'))
        process.env.CODEX_HOME = root
        const sessionsDir = join(root, 'sessions', '2026', '06', '27')
        mkdirSync(sessionsDir, { recursive: true })

        const sessionId = 'lookup-session-id'
        const fillerLine = JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'z'.repeat(4000) }]
            }
        })
        // No change_title event: a full reverse scan would walk to BOF.
        const lines = [
            JSON.stringify({
                type: 'session_meta',
                payload: { id: sessionId, cwd: '/tmp/project' }
            }),
            JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'only head prompt' }]
                }
            }),
            ...Array.from({ length: 80 }, () => fillerLine)
        ]
        const filePath = join(sessionsDir, `${sessionId}.jsonl`)
        writeFileSync(filePath, lines.join('\n') + '\n')
        expect(statSync(filePath).size).toBeGreaterThan(256 * 1024)

        const started = performance.now()
        expect(findCodexSessionFile(sessionId)).toBe(filePath)
        expect(performance.now() - started).toBeLessThan(250)

        rmSync(root, { recursive: true, force: true })
    })

    it('preserves CJK title text when a UTF-8 code point straddles a reverse-scan read-chunk boundary', () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-home-'))
        process.env.CODEX_HOME = root
        const sessionsDir = join(root, 'sessions', '2026', '06', '27')
        mkdirSync(sessionsDir, { recursive: true })

        // Straddle an internal 64 KiB *read* boundary (not the 256 KiB scan-budget edge).
        // A change_title line that starts before the scan window is intentionally out of budget.
        const readChunkBytes = 64 * 1024
        const title = '预算标题'
        const titleLine = JSON.stringify({
            type: 'event_msg',
            payload: {
                type: 'mcp_tool_call_end',
                invocation: {
                    tool: 'change_title',
                    arguments: { title }
                }
            }
        })
        const userLine = JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'cjk boundary prompt' }]
            }
        })
        const metaLine = JSON.stringify({
            type: 'session_meta',
            payload: { id: 'cjk-session-id', cwd: '/tmp/project' }
        })
        const titleUtf8 = Buffer.from(title, 'utf8')
        // Split inside the final CJK code point (3 bytes) across the read-chunk boundary.
        const splitOffsetInTitle = titleUtf8.length - 1
        const beforeTitle = Buffer.from(`${metaLine}\n`, 'utf8')
        const titleLineBuf = Buffer.from(`${titleLine}\n`, 'utf8')
        const userLineBuf = Buffer.from(`${userLine}\n`, 'utf8')
        const titleCharStartInLine = titleLineBuf.indexOf(titleUtf8)
        expect(titleCharStartInLine).toBeGreaterThanOrEqual(0)
        const splitAt = beforeTitle.length + titleCharStartInLine + splitOffsetInTitle
        const prefix = Buffer.concat([beforeTitle, titleLineBuf, userLineBuf])
        expect(splitAt).toBeLessThan(prefix.length)
        const fillerLen = readChunkBytes - (prefix.length - splitAt)
        expect(fillerLen).toBeGreaterThan(0)
        // ASCII filler only - no trailing newline - so size - readChunkBytes lands mid-codepoint.
        const filler = Buffer.alloc(fillerLen, 0x61)
        const filePath = join(sessionsDir, 'cjk.jsonl')
        writeFileSync(filePath, Buffer.concat([prefix, filler]))
        expect(statSync(filePath).size - readChunkBytes).toBe(splitAt)
        // Whole file stays inside the 256 KiB scan budget so the title remains in-window.
        expect(statSync(filePath).size).toBeLessThan(256 * 1024)

        const sessions = listLocalCodexSessionSummaries()
        expect(sessions).toHaveLength(1)
        expect(sessions[0]?.title).toBe(title)
        expect(sessions[0]?.lastUserMessage).toBe('cjk boundary prompt')

        rmSync(root, { recursive: true, force: true })
    })
})
