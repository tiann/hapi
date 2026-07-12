/**
 * Seed assistant messages with mermaid fixtures into a hub SQLite DB.
 * Run on the host that owns HAPI_DB_PATH (usually the hub machine).
 *
 *   HAPI_DB_PATH=~/.hapi/hapi.db SESSION_ID=<uuid> bun run scripts/dev/mermaid-lightbox-seed-session-db.ts
 */
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
    MERMAID_LIGHTBOX_CASE_IDS,
    MERMAID_LIGHTBOX_CASES,
} from '../../web/src/dev/mermaid-lightbox-cases'

const dbPath = process.env.HAPI_DB_PATH ?? join(homedir(), '.hapi', 'hapi.db')
/** Stable id for mermaid Playwright live session (create if missing). */
const sessionId = process.env.SESSION_ID ?? 'a7370000-0000-4000-8000-000000000737'
const sessionTag = 'mermaid-lightbox-e2e'

function agentMermaidEnvelope(caseId: string, code: string) {
    const text = `<!-- mermaid-e2e:${caseId} -->\n\`\`\`mermaid\n${code.trim()}\n\`\`\``
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'assistant',
                uuid: randomUUID(),
                parentUuid: null,
                isSidechain: false,
                message: {
                    content: [{ type: 'text', text }],
                },
            },
        },
    }
}

const db = new Database(dbPath)
const now = Date.now()
const existing = db.prepare('SELECT id, tag FROM sessions WHERE id = ?').get(sessionId) as
    | { id: string; tag: string | null }
    | undefined

if (existing && existing.tag !== sessionTag) {
    throw new Error(
        `Refusing to seed mermaid fixtures into session ${sessionId}: tag is `
            + `${JSON.stringify(existing.tag)}, expected ${JSON.stringify(sessionTag)}. `
            + `Unset SESSION_ID or use a session created by this script.`,
    )
}

if (!existing) {
    db.prepare(`
        INSERT INTO sessions (
            id, tag, namespace, created_at, updated_at, active, seq
        ) VALUES (?, ?, 'default', ?, ?, 0, 0)
    `).run(sessionId, sessionTag, now, now)
    console.log(`created session ${sessionId} (${sessionTag})`)
}

const insert = db.prepare(`
    INSERT INTO messages (id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)
`)

db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)

let seqRow = db.prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages WHERE session_id = ?').get(sessionId) as {
    maxSeq: number
}

for (const caseId of MERMAID_LIGHTBOX_CASE_IDS) {
    const code = MERMAID_LIGHTBOX_CASES[caseId]
    const envelope = agentMermaidEnvelope(caseId, code)
    const seq = (seqRow.maxSeq ?? 0) + 1
    seqRow = { maxSeq: seq }
    const messageId = randomUUID()
    insert.run(messageId, sessionId, JSON.stringify(envelope), now, seq, now)
    console.log(`seeded ${caseId} @ seq ${seq}`)
}

db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId)
console.log(`Done. Open: /sessions/${sessionId}`)
