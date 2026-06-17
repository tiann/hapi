import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { Store } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createClaudeDesktopRoutes, importSelectedClaudeSessions, listLocalClaudeSessions } from './claudeDesktop'

const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR

// 中文注释：写一条“内容丰富”的 Claude transcript，覆盖 user 字符串 / assistant text+thinking+tool_use / user tool_result，并夹杂若干 sidecar。
function createRichTranscript(claudeHome: string, sessionId: string, encodedCwd = '-home-user-project', cwd: string | null = '/home/user/project'): void {
    const projectDir = join(claudeHome, 'projects', encodedCwd)
    mkdirSync(projectDir, { recursive: true })
    const transcriptPath = join(projectDir, `${sessionId}.jsonl`)
    const lines: unknown[] = [
        // sidecar lines: must be skipped
        { type: 'last-prompt', prompt: 'ignored' },
        { type: 'mode', mode: 'default' },
        { type: 'attachment', sessionId, content: 'ignored' },
        // isMeta user line: skipped
        { type: 'user', isMeta: true, sessionId, cwd, message: { role: 'user', content: '<local-command-caveat>ignored</local-command-caveat>' } },
        // real user message (string content)
        { type: 'user', sessionId, cwd, message: { role: 'user', content: 'hello claude' } },
        // assistant with thinking + text + tool_use
        {
            type: 'assistant',
            sessionId,
            cwd,
            message: {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'let me think' },
                    { type: 'text', text: 'working on it' },
                    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/x' } }
                ]
            }
        },
        // user line carrying a tool_result block
        {
            type: 'user',
            sessionId,
            cwd,
            message: {
                role: 'user',
                content: [
                    { tool_use_id: 'toolu_1', type: 'tool_result', content: [{ type: 'text', text: 'file contents' }] }
                ]
            }
        },
        // assistant final text
        { type: 'assistant', sessionId, cwd, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
        // more sidecar
        { type: 'ai-title', title: 'some title' }
    ]
    writeFileSync(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf-8')
}

function createSidecarOnlyTranscript(claudeHome: string, sessionId: string, encodedCwd = '-home-user-empty'): void {
    const projectDir = join(claudeHome, 'projects', encodedCwd)
    mkdirSync(projectDir, { recursive: true })
    const transcriptPath = join(projectDir, `${sessionId}.jsonl`)
    const lines: unknown[] = [
        { type: 'last-prompt', prompt: 'ignored' },
        { type: 'mode', mode: 'default' },
        { type: 'ai-title', title: 'no real conversation' },
        { type: 'user', isMeta: true, sessionId, message: { role: 'user', content: '<system-meta>ignored</system-meta>' } }
    ]
    writeFileSync(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf-8')
}

function createRoutesApp(namespace: string, store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        await next()
    })
    app.route('/api', createClaudeDesktopRoutes({
        store,
        getSyncEngine: () => null
    }))
    return app
}

describe('Claude Desktop import routes', () => {
    afterEach(() => {
        if (originalClaudeConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR
        } else {
            process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
        }
    })

    it('maps user/assistant text, thinking, tool_use and tool_result, skipping sidecar lines', async () => {
        const claudeHome = mkdtempSync(join(tmpdir(), 'hapi-claude-home-test-'))
        const store = new Store(':memory:')
        const sessionId = '11111111-1111-4111-8111-111111111111'
        process.env.CLAUDE_CONFIG_DIR = claudeHome

        try {
            createRichTranscript(claudeHome, sessionId)

            const result = await importSelectedClaudeSessions({
                claudeSessionIds: [sessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => null
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session).toBeDefined()
            expect(session.metadata).toMatchObject({
                flavor: 'claude',
                claudeSessionId: sessionId,
                path: '/home/user/project',
                lifecycleState: 'imported'
            })

            const messages = store.messages.getAllMessages(session.id)
            // user(string), thinking, text, tool_use, tool_result, final text => 6
            expect(messages).toHaveLength(6)

            expect(messages[0].content).toEqual({
                role: 'user',
                content: { type: 'text', text: 'hello claude' },
                meta: { sentFrom: 'cli' }
            })
            expect((messages[1].content as { content: { data: unknown } }).content.data).toMatchObject({
                type: 'reasoning',
                message: 'let me think'
            })
            expect((messages[2].content as { content: { data: unknown } }).content.data).toMatchObject({
                type: 'message',
                message: 'working on it'
            })
            expect((messages[3].content as { content: { data: unknown } }).content.data).toMatchObject({
                type: 'tool-call',
                name: 'Read',
                callId: 'toolu_1',
                input: { file_path: '/tmp/x' }
            })
            expect((messages[4].content as { content: { data: { type: string; callId: string } } }).content.data).toMatchObject({
                type: 'tool-call-result',
                callId: 'toolu_1'
            })
            expect((messages[5].content as { content: { data: unknown } }).content.data).toMatchObject({
                type: 'message',
                message: 'done'
            })
            expect(messages[2].content).toMatchObject({
                content: { type: AGENT_MESSAGE_PAYLOAD_TYPE }
            })
        } finally {
            store.close()
            rmSync(claudeHome, { recursive: true, force: true })
        }
    })

    it('is idempotent: re-importing the same session adds no duplicate session or messages', async () => {
        const claudeHome = mkdtempSync(join(tmpdir(), 'hapi-claude-home-idem-test-'))
        const store = new Store(':memory:')
        const sessionId = '22222222-2222-4222-8222-222222222222'
        process.env.CLAUDE_CONFIG_DIR = claudeHome

        try {
            createRichTranscript(claudeHome, sessionId)

            const first = await importSelectedClaudeSessions({
                claudeSessionIds: [sessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => null
            })
            expect(first.success).toBe(true)

            const sessionsAfterFirst = store.sessions.getSessionsByNamespace('default')
            expect(sessionsAfterFirst).toHaveLength(1)
            const messagesAfterFirst = store.messages.getAllMessages(sessionsAfterFirst[0].id).length

            const second = await importSelectedClaudeSessions({
                claudeSessionIds: [sessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => null
            })
            expect(second.success).toBe(true)

            const sessionsAfterSecond = store.sessions.getSessionsByNamespace('default')
            expect(sessionsAfterSecond).toHaveLength(1)
            expect(sessionsAfterSecond[0].id).toBe(sessionsAfterFirst[0].id)
            const messagesAfterSecond = store.messages.getAllMessages(sessionsAfterSecond[0].id).length
            expect(messagesAfterSecond).toBe(messagesAfterFirst)
        } finally {
            store.close()
            rmSync(claudeHome, { recursive: true, force: true })
        }
    })

    it('filters out empty / sidecar-only sessions from listing', () => {
        const claudeHome = mkdtempSync(join(tmpdir(), 'hapi-claude-home-empty-test-'))
        const sessionId = '33333333-3333-4333-8333-333333333333'
        process.env.CLAUDE_CONFIG_DIR = claudeHome

        try {
            createSidecarOnlyTranscript(claudeHome, sessionId)
            const sessions = listLocalClaudeSessions()
            expect(sessions).toHaveLength(0)
        } finally {
            rmSync(claudeHome, { recursive: true, force: true })
        }
    })

    it('lists real sessions and rejects non-default namespace', async () => {
        const claudeHome = mkdtempSync(join(tmpdir(), 'hapi-claude-home-route-test-'))
        const sessionId = '44444444-4444-4444-8444-444444444444'
        process.env.CLAUDE_CONFIG_DIR = claudeHome

        try {
            createRichTranscript(claudeHome, sessionId)

            const defaultStore = new Store(':memory:')
            try {
                const defaultApp = createRoutesApp('default', defaultStore)
                const response = await defaultApp.request('/api/claude/sessions')
                expect(response.status).toBe(200)
                const body = await response.json() as { success: boolean; sessions: { id: string }[] }
                expect(body.success).toBe(true)
                expect(body.sessions.map((s) => s.id)).toContain(sessionId)
            } finally {
                defaultStore.close()
            }

            const teamStore = new Store(':memory:')
            try {
                const teamApp = createRoutesApp('team-a', teamStore)
                const denied = await teamApp.request('/api/claude/sessions')
                expect(denied.status).toBe(403)
            } finally {
                teamStore.close()
            }
        } finally {
            rmSync(claudeHome, { recursive: true, force: true })
        }
    })
})
