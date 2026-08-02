#!/usr/bin/env bun
/**
 * Cleanup script to delete sessions from the database.
 *
 * Supports filtering by:
 * - Message count: Delete sessions with fewer than N messages
 * - Path pattern: Delete sessions matching a glob pattern
 * - Message pattern: Delete sessions whose first message contains a pattern
 * - Orphaned: Delete sessions whose path no longer exists
 *
 * Usage:
 *   bun run hub/scripts/cleanup-sessions.ts [options]
 *
 * Options:
 *   --min-messages=N   Delete sessions with fewer than N messages (default: 5)
 *   --path=PATTERN     Delete sessions matching path pattern (glob supported)
 *   --message=PATTERN  Delete sessions whose first message contains PATTERN (case-insensitive)
 *   --orphaned         Delete sessions whose path no longer exists
 *   --force            Skip confirmation prompt
 *   --help             Show this help message
 *
 * Examples:
 *   bun run hub/scripts/cleanup-sessions.ts
 *   bun run hub/scripts/cleanup-sessions.ts --min-messages=3
 *   bun run hub/scripts/cleanup-sessions.ts --path="/tmp/*"
 *   bun run hub/scripts/cleanup-sessions.ts --message="hello"
 *   bun run hub/scripts/cleanup-sessions.ts --orphaned
 *   bun run hub/scripts/cleanup-sessions.ts --orphaned --min-messages=5 --force
 */

import { Database } from 'bun:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

import { decodeMessageContent } from '../src/store/contentCodec'

// Format timestamp as human-readable date
function formatDate(timestamp: number): string {
    const date = new Date(timestamp)
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
    })
}

// Truncate string to max length with ellipsis
function truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str
    return str.slice(0, maxLen - 3) + '...'
}

// Extract text from user message content
function extractUserText(content: unknown): string | null {
    if (!content || typeof content !== 'object') return null
    const c = content as Record<string, unknown>
    if (c.role !== 'user') return null
    const inner = c.content
    // Handle { content: { type: 'text', text: '...' } }
    if (inner && typeof inner === 'object') {
        const textObj = inner as Record<string, unknown>
        if (textObj.type === 'text' && typeof textObj.text === 'string') {
            return textObj.text
        }
    }
    // Handle { content: '...' } (string)
    if (typeof inner === 'string') {
        return inner
    }
    return null
}

// Parse command line arguments
function parseArgs(): { minMessages: number | null; pathPattern: string | null; messagePattern: string | null; orphaned: boolean; force: boolean; help: boolean } {
    const args = process.argv.slice(2)
    let minMessages: number | null = null
    let pathPattern: string | null = null
    let messagePattern: string | null = null
    let orphaned = false
    let force = false
    let help = false

    for (const arg of args) {
        if (arg === '--help' || arg === '-h') {
            help = true
        } else if (arg === '--force' || arg === '-f') {
            force = true
        } else if (arg === '--orphaned') {
            orphaned = true
        } else if (arg.startsWith('--min-messages=')) {
            const value = parseInt(arg.split('=')[1], 10)
            if (isNaN(value) || value < 0) {
                console.error('Error: --min-messages must be a non-negative integer')
                process.exit(1)
            }
            minMessages = value
        } else if (arg.startsWith('--path=')) {
            pathPattern = arg.split('=').slice(1).join('=') // Handle paths with '='
        } else if (arg.startsWith('--message=')) {
            messagePattern = arg.split('=').slice(1).join('=').toLowerCase()
        } else {
            console.error(`Unknown argument: ${arg}`)
            console.error('Use --help for usage information')
            process.exit(1)
        }
    }

    // Default behavior: if no filters specified, use min-messages=5
    if (minMessages === null && pathPattern === null && messagePattern === null && !orphaned) {
        minMessages = 5
    }

    return { minMessages, pathPattern, messagePattern, orphaned, force, help }
}

// Get database path (same logic as configuration.ts)
function getDbPath(): string {
    if (process.env.DB_PATH) {
        return process.env.DB_PATH.replace(/^~/, homedir())
    }
    const dataDir = process.env.HAPI_HOME
        ? process.env.HAPI_HOME.replace(/^~/, homedir())
        : join(homedir(), '.hapi')
    return join(dataDir, 'hapi.db')
}

// Session info for display
interface SessionInfo {
    id: string
    title: string | null
    firstUserMessage: string | null
    path: string | null
    updatedAt: number
    messageCount: number
}

// Query sessions with message counts
function querySessions(db: Database): SessionInfo[] {
    // Get basic session info
    const sessionRows = db.query<
        { id: string; metadata: string | null; updated_at: number; message_count: number },
        []
    >(`
        SELECT
            s.id,
            s.metadata,
            s.updated_at,
            COUNT(m.id) as message_count
        FROM sessions s
        LEFT JOIN messages m ON m.session_id = s.id
        GROUP BY s.id
    `).all()

    // Scan each session's messages in seq order, in small batches, until the
    // first user prompt is found. Loading every row at once pulls the whole
    // DB's content into RAM on large DBs, but the scan must not stop at a
    // fixed rank either — sessions can lead with dozens of agent rows.
    const batchQuery = db.query<
        { content: string | Uint8Array },
        [string, number, number]
    >(`
        SELECT content FROM messages
        WHERE session_id = ?
        ORDER BY seq
        LIMIT ? OFFSET ?
    `)
    const SCAN_BATCH = 50
    function findFirstUserMessage(sessionId: string): string | null {
        for (let offset = 0; ; offset += SCAN_BATCH) {
            const rows = batchQuery.all(sessionId, SCAN_BATCH, offset)
            if (rows.length === 0) return null
            for (const row of rows) {
                // decodeMessageContent handles both legacy plaintext and zstd BLOB rows
                const userText = extractUserText(decodeMessageContent(row.content))
                if (userText) return userText
            }
        }
    }

    return sessionRows.map(row => {
        let path: string | null = null
        let title: string | null = null
        if (row.metadata) {
            try {
                const metadata = JSON.parse(row.metadata)
                path = metadata.path ?? null
                // Get title from metadata.summary.text
                if (metadata.summary && typeof metadata.summary.text === 'string') {
                    title = metadata.summary.text
                }
            } catch {
                // Ignore parse errors
            }
        }

        const firstUserMessage = findFirstUserMessage(row.id)

        return {
            id: row.id,
            title,
            firstUserMessage,
            path,
            updatedAt: row.updated_at,
            messageCount: row.message_count,
        }
    })
}

// Filter sessions based on criteria
function filterSessions(
    sessions: SessionInfo[],
    minMessages: number | null,
    pathPattern: string | null,
    messagePattern: string | null,
    orphaned: boolean
): SessionInfo[] {
    let filtered = sessions

    // Filter by message count if specified
    if (minMessages !== null) {
        filtered = filtered.filter(s => s.messageCount < minMessages)
    }

    // Filter by path pattern if specified
    if (pathPattern !== null) {
        const glob = new Bun.Glob(pathPattern)
        filtered = filtered.filter(s => {
            if (!s.path) return false
            return glob.match(s.path)
        })
    }

    // Filter by first message pattern (case-insensitive fuzzy match)
    if (messagePattern !== null) {
        filtered = filtered.filter(s => {
            if (!s.firstUserMessage) return false
            return s.firstUserMessage.toLowerCase().includes(messagePattern)
        })
    }

    // Filter by orphaned (path does not exist) if specified
    if (orphaned) {
        filtered = filtered.filter(s => {
            if (!s.path) return true // No path = orphaned
            return !existsSync(s.path)
        })
    }

    return filtered
}

// Display sessions in a table format
function displaySessions(sessions: SessionInfo[]): void {
    if (sessions.length === 0) {
        console.log('No sessions match the criteria.')
        return
    }

    // Fixed column widths for readability
    const dateWidth = 12
    const countWidth = 4
    const titleWidth = 25
    const messageWidth = 30
    const pathWidth = 30

    // Header
    const header = [
        'Updated'.padEnd(dateWidth),
        'Msgs'.padStart(countWidth),
        'Title'.padEnd(titleWidth),
        'First Message'.padEnd(messageWidth),
        'Path'.padEnd(pathWidth),
    ].join(' | ')
    console.log(header)
    console.log('-'.repeat(header.length))

    // Rows
    for (const s of sessions) {
        const updated = formatDate(s.updatedAt)
        const title = truncate(s.title ?? '(no title)', titleWidth)
        const firstMsg = truncate(s.firstUserMessage ?? '(no message)', messageWidth)
        const path = truncate(s.path ?? '', pathWidth)

        console.log([
            updated.padEnd(dateWidth),
            s.messageCount.toString().padStart(countWidth),
            title.padEnd(titleWidth),
            firstMsg.padEnd(messageWidth),
            path.padEnd(pathWidth),
        ].join(' | '))
    }
}

// Prompt for confirmation
async function confirm(message: string): Promise<boolean> {
    process.stdout.write(`${message} [y/N]: `)
    for await (const line of console) {
        const answer = line.trim().toLowerCase()
        return answer === 'y' || answer === 'yes'
    }
    return false
}

// Delete sessions by IDs
function deleteSessions(db: Database, ids: string[]): number {
    if (ids.length === 0) return 0

    const placeholders = ids.map(() => '?').join(', ')
    db.run(`DELETE FROM sessions WHERE id IN (${placeholders})`, ids)
    return ids.length
}

// Main function
async function main(): Promise<void> {
    const { minMessages, pathPattern, messagePattern, orphaned, force, help } = parseArgs()

    if (help) {
        console.log(`
Usage: bun run hub/scripts/cleanup-sessions.ts [options]

Options:
  --min-messages=N   Delete sessions with fewer than N messages (default: 5)
  --path=PATTERN     Delete sessions matching path pattern (glob supported)
  --message=PATTERN  Delete sessions whose first message contains PATTERN (case-insensitive)
  --orphaned         Delete sessions whose path no longer exists
  --force            Skip confirmation prompt
  --help             Show this help message

Filtering logic:
  - Only --min-messages: Delete sessions with message count < N
  - Only --path: Delete ALL sessions matching the path pattern
  - Only --message: Delete sessions whose first user message contains the pattern
  - Only --orphaned: Delete sessions whose path does not exist on filesystem
  - Multiple filters: Delete sessions matching ALL conditions (AND)

Examples:
  bun run hub/scripts/cleanup-sessions.ts
  bun run hub/scripts/cleanup-sessions.ts --min-messages=3
  bun run hub/scripts/cleanup-sessions.ts --path="/tmp/*"
  bun run hub/scripts/cleanup-sessions.ts --message="hello"
  bun run hub/scripts/cleanup-sessions.ts --orphaned
  bun run hub/scripts/cleanup-sessions.ts --orphaned --min-messages=5 --force
`)
        process.exit(0)
    }

    // Check database exists
    const dbPath = getDbPath()
    if (!existsSync(dbPath)) {
        console.error(`Database not found: ${dbPath}`)
        process.exit(1)
    }

    console.log(`Database: ${dbPath}`)

    // Open database
    const db = new Database(dbPath)
    db.run('PRAGMA foreign_keys = ON')

    try {
        // Query all sessions
        const allSessions = querySessions(db)
        console.log(`Total sessions: ${allSessions.length}`)

        // Apply filters
        const toDelete = filterSessions(allSessions, minMessages, pathPattern, messagePattern, orphaned)

        // Display filter criteria
        const criteria: string[] = []
        if (minMessages !== null) {
            criteria.push(`message count < ${minMessages}`)
        }
        if (pathPattern !== null) {
            criteria.push(`path matches "${pathPattern}"`)
        }
        if (messagePattern !== null) {
            criteria.push(`first message contains "${messagePattern}"`)
        }
        if (orphaned) {
            criteria.push('path does not exist')
        }
        console.log(`Filter: ${criteria.join(' AND ')}`)
        console.log(`Sessions to delete: ${toDelete.length}`)
        console.log()

        if (toDelete.length === 0) {
            console.log('Nothing to delete.')
            return
        }

        // Display sessions
        displaySessions(toDelete)
        console.log()

        // Confirm deletion
        if (!force) {
            const confirmed = await confirm(`Delete ${toDelete.length} session(s)?`)
            if (!confirmed) {
                console.log('Aborted.')
                return
            }
        }

        // Delete sessions
        const deleted = deleteSessions(db, toDelete.map(s => s.id))
        console.log(`Deleted ${deleted} session(s) and their messages.`)
    } finally {
        db.close()
    }
}

main().catch(err => {
    console.error('Error:', err.message)
    process.exit(1)
})
