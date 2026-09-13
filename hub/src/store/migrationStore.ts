import type { Database } from 'bun:sqlite'

export class MigrationStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    isCompleted(migrationId: string): boolean {
        return Boolean(this.db.prepare(
            'SELECT 1 FROM migration_state WHERE migration_id = ? LIMIT 1'
        ).get(migrationId))
    }

    markCompleted(migrationId: string, completedAt: number = Date.now()): void {
        this.db.prepare(`
            INSERT OR IGNORE INTO migration_state (migration_id, completed_at)
            VALUES (?, ?)
        `).run(migrationId, completedAt)
    }
}
