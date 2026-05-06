#!/usr/bin/env bun
import { Database } from 'bun:sqlite'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Store } from '../../hub/src/store'

function argValue(name: string, fallback?: string): string | undefined {
    const prefix = `${name}=`
    const directIndex = process.argv.indexOf(name)
    if (directIndex >= 0) return process.argv[directIndex + 1]
    const direct = process.argv.find((arg) => arg.startsWith(prefix))
    return direct ? direct.slice(prefix.length) : fallback
}

const dbPath = resolve(argValue('--db', process.env.DB_PATH ?? '/tmp/hapi-dev-codex-web/hapi.db')!)
const reset = process.argv.includes('--reset')
const namespace = argValue('--namespace', 'default')!
const tag = argValue('--tag', 'codex-web-fixture')!
const now = Date.now()

mkdirSync(dirname(dbPath), { recursive: true })
if (reset) {
    rmSync(dbPath, { force: true })
    rmSync(`${dbPath}-wal`, { force: true })
    rmSync(`${dbPath}-shm`, { force: true })
}

const store = new Store(dbPath)
const session = store.sessions.getOrCreateSession(tag, {
    path: '/tmp/hapi-fixture-workspace',
    host: 'hapi-dev-fixture',
    version: 'dev',
    flavor: 'codex',
    codexSessionId: 'codex-fixture-session',
    name: 'Codex Web Fixture'
}, {
    controlledByUser: false,
    requests: {},
    completedRequests: {}
}, namespace, 'gpt-5.4', undefined, 'xhigh')

const messages = [
    {
        localId: 'fixture-user-1',
        content: {
            role: 'user',
            content: { type: 'text', text: 'Fixture request: show Codex reasoning, MCP calls, and plan status.' },
            meta: { sentFrom: 'fixture' }
        }
    },
    {
        localId: 'fixture-agent-message',
        content: {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    message: 'Codex fixture response visible in HAPI Web.',
                    id: 'fixture-msg-1'
                }
            },
            meta: { sentFrom: 'fixture' }
        }
    },
    {
        localId: 'fixture-reasoning',
        content: {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'reasoning',
                    message: 'Fixture reasoning detail: inspect event normalization before rendering.',
                    id: 'fixture-reasoning-1'
                }
            },
            meta: { sentFrom: 'fixture' }
        }
    },
    {
        localId: 'fixture-mcp-call',
        content: {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call',
                    name: 'mcp__fixture__lookup_context',
                    callId: 'fixture-mcp-call-1',
                    input: {
                        server: 'fixture-mcp-server',
                        tool: 'lookup_context',
                        query: 'codex plan visibility'
                    },
                    id: 'fixture-tool-1'
                }
            },
            meta: { sentFrom: 'fixture' }
        }
    },
    {
        localId: 'fixture-mcp-result',
        content: {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call-result',
                    callId: 'fixture-mcp-call-1',
                    output: {
                        server: 'fixture-mcp-server',
                        tool: 'lookup_context',
                        result: 'Fixture MCP result visible in Web.'
                    },
                    id: 'fixture-tool-result-1'
                }
            },
            meta: { sentFrom: 'fixture' }
        }
    },
    {
        localId: 'fixture-plan-update',
        content: {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'plan_update',
                    plan: [
                        { step: 'Inspect event stream', status: 'completed' },
                        { step: 'Render plan card', status: 'in_progress' },
                        { step: 'Verify web DOM', status: 'pending' }
                    ],
                    id: 'fixture-plan-update-1'
                }
            },
            meta: { sentFrom: 'fixture' }
        }
    }
]

for (const message of messages) {
    store.messages.addMessage(session.id, message.content, message.localId)
}

// Make the fixture visually prominent in session lists without needing a live CLI heartbeat.
const db = new Database(dbPath)
db.prepare('UPDATE sessions SET active = 1, active_at = ?, updated_at = ? WHERE id = ?').run(now, now, session.id)
db.close()

console.log(JSON.stringify({
    dbPath,
    sessionId: session.id,
    namespace,
    tag,
    urlPath: `/sessions/${session.id}`,
    messageCount: messages.length
}, null, 2))
