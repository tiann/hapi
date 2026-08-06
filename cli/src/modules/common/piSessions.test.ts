import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listLocalPiSessionSummaries, listLocalPiSessionsWithMessagesByIds } from './piSessions'

describe('local Pi sessions', () => {
    const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR

    afterEach(() => {
        if (originalSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
        else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir
    })

    it('keeps only the active leaf ancestry and converts Pi history blocks', () => {
        const root = mkdtempSync(join(tmpdir(), 'pi-sessions-'))
        process.env.PI_CODING_AGENT_SESSION_DIR = root
        const bucket = join(root, '--tmp-project--')
        mkdirSync(bucket, { recursive: true })
        const file = join(bucket, 'session.jsonl')
        writeFileSync(file, [
            { type: 'session', version: 3, id: 'pi-session-1', timestamp: '2026-08-04T01:00:00Z', cwd: '/tmp/project' },
            { type: 'message', id: 'user-1', parentId: null, timestamp: '2026-08-04T01:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }] } },
            { type: 'message', id: 'old-branch', parentId: 'user-1', timestamp: '2026-08-04T01:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'old branch' }] } },
            { type: 'message', id: 'assistant-1', parentId: 'user-1', timestamp: '2026-08-04T01:00:03Z', message: { role: 'assistant', model: 'gpt-5.6', content: [
                { type: 'thinking', thinking: 'reasoning' },
                { type: 'text', text: 'answer' },
                { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'a.ts' } }
            ], usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18 } } },
            { type: 'message', id: 'tool-result-1', parentId: 'assistant-1', timestamp: '2026-08-04T01:00:04Z', message: { role: 'toolResult', toolCallId: 'tool-1', content: 'ok', isError: false } },
            { type: 'custom_message', id: 'custom-1', parentId: 'tool-result-1', timestamp: '2026-08-04T01:00:05Z', display: true, content: 'visible extension result' },
            { type: 'compaction', id: 'compact-1', parentId: 'custom-1', timestamp: '2026-08-04T01:00:06Z', summary: 'condensed context' },
            { type: 'session_info', id: 'info-1', parentId: 'compact-1', timestamp: '2026-08-04T01:00:07Z', name: 'Imported Pi session' }
        ].map((line) => JSON.stringify(line)).join('\n'))

        const summaries = listLocalPiSessionSummaries()
        expect(summaries).toEqual([expect.objectContaining({
            id: 'pi-session-1',
            title: 'Imported Pi session',
            cwd: '/tmp/project',
            model: 'gpt-5.6',
            leafEntryId: 'info-1',
            messageCount: 8
        })])

        const sessions = listLocalPiSessionsWithMessagesByIds(new Set(['pi-session-1']))
        expect(sessions).toHaveLength(1)
        expect(sessions[0]?.messages.some((message) => JSON.stringify(message.content).includes('old branch'))).toBe(false)
        expect(sessions[0]?.messages.map((message) => message.localId)).toEqual([
            'pi:pi-session-1:user-1:user',
            'pi:pi-session-1:assistant-1:0',
            'pi:pi-session-1:assistant-1:1',
            'pi:pi-session-1:assistant-1:2',
            'pi:pi-session-1:assistant-1:usage',
            'pi:pi-session-1:tool-result-1:tool-result',
            'pi:pi-session-1:custom-1:custom_message',
            'pi:pi-session-1:compact-1:compaction'
        ])
        expect(sessions[0]?.messages.find((message) => message.localId.endsWith(':usage'))).toMatchObject({
            content: {
                content: {
                    data: {
                        type: 'token_count',
                        usageSchema: 'hapi.usage.v1',
                        inputTokenSemantics: 'includes-cache'
                    }
                }
            }
        })
        expect(sessions[0]?.messages[0]).toMatchObject({
            entryId: 'user-1',
            parentEntryId: null,
            createdAt: Date.parse('2026-08-04T01:00:01Z'),
            content: { role: 'user' }
        })
        rmSync(root, { recursive: true, force: true })
    })

    it('honors environment precedence, skips malformed lines, and deduplicates by newest file', () => {
        const root = mkdtempSync(join(tmpdir(), 'pi-sessions-'))
        process.env.PI_CODING_AGENT_SESSION_DIR = root
        for (const [folder, title] of [['older', 'old'], ['newer', 'new']] as const) {
            const bucket = join(root, folder)
            mkdirSync(bucket, { recursive: true })
            const file = join(bucket, `${title}.jsonl`)
            writeFileSync(file, [
                '{broken',
                JSON.stringify({ type: 'session', id: 'same-session', cwd: '/tmp/project' }),
                JSON.stringify({ type: 'message', id: `user-${title}`, parentId: null, message: { role: 'user', content: title } })
            ].join('\n'))
            const time = title === 'new' ? new Date('2026-08-04T02:00:00Z') : new Date('2026-08-04T01:00:00Z')
            utimesSync(file, time, time)
        }

        expect(listLocalPiSessionSummaries()).toEqual([
            expect.objectContaining({ id: 'same-session', title: 'new', lastUserMessage: 'new' })
        ])
        rmSync(root, { recursive: true, force: true })
    })

    it('keeps image-only user entries as explicit history placeholders', () => {
        const root = mkdtempSync(join(tmpdir(), 'pi-sessions-'))
        process.env.PI_CODING_AGENT_SESSION_DIR = root
        mkdirSync(join(root, 'bucket'), { recursive: true })
        writeFileSync(join(root, 'bucket', 'image.jsonl'), [
            JSON.stringify({ type: 'session', id: 'image-session', cwd: '/tmp/project' }),
            JSON.stringify({
                type: 'message',
                id: 'image-user',
                parentId: null,
                message: { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'base64' }] }
            })
        ].join('\n'))

        const session = listLocalPiSessionsWithMessagesByIds(new Set(['image-session']))[0]
        expect(session?.messages[0]).toMatchObject({
            entryId: 'image-user',
            content: { role: 'user', content: { text: '[Image attachment: image/png]' } }
        })
        rmSync(root, { recursive: true, force: true })
    })

    it('limits summary materialization while selected-id lookup can still reach older sessions', () => {
        const root = mkdtempSync(join(tmpdir(), 'pi-sessions-'))
        process.env.PI_CODING_AGENT_SESSION_DIR = root
        mkdirSync(join(root, 'bucket'), { recursive: true })
        for (let index = 0; index < 205; index += 1) {
            const file = join(root, 'bucket', `${index}.jsonl`)
            writeFileSync(file, [
                JSON.stringify({ type: 'session', id: `session-${index}`, cwd: '/tmp/project' }),
                JSON.stringify({ type: 'message', id: `user-${index}`, parentId: null, message: { role: 'user', content: `prompt-${index}` } })
            ].join('\n'))
            const time = new Date(1_700_000_000_000 + index * 1_000)
            utimesSync(file, time, time)
        }

        const summaries = listLocalPiSessionSummaries(2)
        expect(summaries.map((session) => session.id)).toEqual(['session-204', 'session-203'])
        expect(listLocalPiSessionsWithMessagesByIds(new Set(['session-0']))[0]).toMatchObject({
            id: 'session-0',
            lastUserMessage: 'prompt-0'
        })
        rmSync(root, { recursive: true, force: true })
    })
})
