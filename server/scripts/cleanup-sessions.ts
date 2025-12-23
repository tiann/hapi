#!/usr/bin/env bun
/**
 * Cleanup script to delete sessions from the database.
 *
 * Supports filtering by:
 * - Message count: Delete sessions with fewer than N messages
 * - Path pattern: Delete sessions matching a glob pattern
 * - Orphaned: Delete sessions whose path no longer exists
 *
 * Usage:
 *   bun run server/scripts/cleanup-sessions.ts [options]
 *
 * Options:
 *   --min-messages=N   Delete sessions with fewer than N messages (default: 5)
 *   --path=PATTERN     Delete sessions matching path pattern (glob supported)
 *   --orphaned         Delete sessions whose path no longer exists
 *   --force            Skip confirmation prompt
 *   --help             Show this help message
 *
 * Examples:
 *   bun run server/scripts/cleanup-sessions.ts
 *   bun run server/scripts/cleanup-sessions.ts --min-messages=3
 *   bun run server/scripts/cleanup-sessions.ts --path="/tmp/*"
 *   bun run server/scripts/cleanup-sessions.ts --orphaned
 *   bun run server/scripts/cleanup-sessions.ts --orphaned --min-messages=5 --force
 */

import { Database } from 'bun:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

// Parse command line arguments
function parseArgs(): { minMessages: number | null; pathPattern: string | null; orphaned: boolean; force: boolean; help: boolean } {
    const args = process.argv.slice(2)
    let minMessages: number | null = null
    let pathPattern: string | null = null
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
        } else {
            console.error(`Unknown argument: ${arg}`)
            console.error('Use --help for usage information')
            process.exit(1)
        }
    }

    // Default behavior: if no filters specified, use min-messages=5
    if (minMessages === null && pathPattern === null && !orphaned) {
        minMessages = 5
    }

    return { minMessages, pathPattern, orphaned, force, help }
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
    tag: string | null
    path: string | null
    messageCount: number
}

// Query sessions with message counts
function querySessions(db: Database): SessionInfo[] {
    const rows = db.query<
        { id: string; tag: string | null; metadata: string | null; message_count: number },
        []
    >(`
        SELECT
            s.id,
            s.tag,
            s.metadata,
            COUNT(m.id) as message_count
        FROM sessions s
        LEFT JOIN messages m ON m.session_id = s.id
        GROUP BY s.id
    `).all()

    return rows.map(row => {
        let path: string | null = null
        if (row.metadata) {
            try {
                const metadata = JSON.parse(row.metadata)
                path = metadata.path ?? null
            } catch {
                // Ignore parse errors
            }
        }
        return {
            id: row.id,
            tag: row.tag,
            path,
            messageCount: row.message_count,
        }
    })
}

// Filter sessions based on criteria
function filterSessions(
    sessions: SessionInfo[],
    minMessages: number | null,
    pathPattern: string | null,
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

    // Calculate column widths
    const idWidth = Math.max(8, ...sessions.map(s => s.id.length))
    const tagWidth = Math.max(3, ...sessions.map(s => (s.tag ?? '').length))
    const pathWidth = Math.max(4, ...sessions.map(s => (s.path ?? '').length))
    const countWidth = 5

    // Header
    const header = [
        'ID'.padEnd(idWidth),
        'Tag'.padEnd(tagWidth),
        'Path'.padEnd(pathWidth),
        'Msgs'.padStart(countWidth),
    ].join(' | ')
    console.log(header)
    console.log('-'.repeat(header.length))

    // Rows
    for (const s of sessions) {
        console.log([
            s.id.padEnd(idWidth),
            (s.tag ?? '').padEnd(tagWidth),
            (s.path ?? '').padEnd(pathWidth),
            s.messageCount.toString().padStart(countWidth),
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
    const result = db.run(`DELETE FROM sessions WHERE id IN (${placeholders})`, ids)
    return result.changes
}

// Main function
async function main(): Promise<void> {
    const { minMessages, pathPattern, orphaned, force, help } = parseArgs()

    if (help) {
        console.log(`
Usage: bun run server/scripts/cleanup-sessions.ts [options]

Options:
  --min-messages=N   Delete sessions with fewer than N messages (default: 5)
  --path=PATTERN     Delete sessions matching path pattern (glob supported)
  --orphaned         Delete sessions whose path no longer exists
  --force            Skip confirmation prompt
  --help             Show this help message

Filtering logic:
  - Only --min-messages: Delete sessions with message count < N
  - Only --path: Delete ALL sessions matching the path pattern
  - Only --orphaned: Delete sessions whose path does not exist on filesystem
  - Multiple filters: Delete sessions matching ALL conditions (AND)

Examples:
  bun run server/scripts/cleanup-sessions.ts
  bun run server/scripts/cleanup-sessions.ts --min-messages=3
  bun run server/scripts/cleanup-sessions.ts --path="/tmp/*"
  bun run server/scripts/cleanup-sessions.ts --orphaned
  bun run server/scripts/cleanup-sessions.ts --orphaned --min-messages=5 --force
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
        const toDelete = filterSessions(allSessions, minMessages, pathPattern, orphaned)

        // Display filter criteria
        const criteria: string[] = []
        if (minMessages !== null) {
            criteria.push(`message count < ${minMessages}`)
        }
        if (pathPattern !== null) {
            criteria.push(`path matches "${pathPattern}"`)
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
