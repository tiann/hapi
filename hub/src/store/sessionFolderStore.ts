import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import type { CreateSessionFolderRequest, SessionFolder, SessionFoldersResponse } from '@hapi/protocol/apiTypes'

export const SESSION_FOLDERS_TABLES_SQL = `
    CREATE TABLE IF NOT EXISTS session_folders (
        namespace TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        parent_id TEXT,
        PRIMARY KEY (namespace, id),
        FOREIGN KEY (namespace, parent_id) REFERENCES session_folders(namespace, id)
    );
    CREATE INDEX IF NOT EXISTS idx_session_folders_parent ON session_folders(namespace, parent_id);

    CREATE TABLE IF NOT EXISTS session_folder_assignments (
        session_id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        folder_id TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (namespace, folder_id) REFERENCES session_folders(namespace, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_session_folder_assignments_folder
        ON session_folder_assignments(namespace, folder_id);
`

export class SessionFolderStore {
    constructor(private readonly db: Database) {}

    list(namespace: string): SessionFoldersResponse {
        return this.db.transaction(() => {
            const folders = this.db.query<SessionFolder, [string]>(`
                SELECT id, name, parent_id AS parentId
                FROM session_folders
                WHERE namespace = ?
                ORDER BY name COLLATE NOCASE, id
            `).all(namespace)
            const assignments = this.db.query<{ sessionId: string; folderId: string }, [string]>(`
                SELECT session_id AS sessionId, folder_id AS folderId
                FROM session_folder_assignments
                WHERE namespace = ?
            `).all(namespace)
            return {
                folders,
                assignments: Object.fromEntries(assignments.map(({ sessionId, folderId }) => [sessionId, folderId]))
            }
        })()
    }

    create(namespace: string, { name, parentId }: CreateSessionFolderRequest): SessionFolder | null {
        const id = randomUUID()
        const result = this.db.query(`
            INSERT INTO session_folders (namespace, id, name, parent_id)
            SELECT $namespace, $id, $name, $parentId
            WHERE $parentId IS NULL OR EXISTS (
                SELECT 1 FROM session_folders WHERE namespace = $namespace AND id = $parentId
            )
        `).run({ namespace, id, name, parentId })
        return result.changes ? { id, name, parentId } : null
    }

    delete(namespace: string, id: string): boolean {
        // Calculate descendants before deleting so deep trees do not use recursive FK triggers.
        return this.db.query(`
            WITH RECURSIVE subtree(id) AS (
                SELECT id FROM session_folders WHERE namespace = $namespace AND id = $id
                UNION ALL
                SELECT folder.id FROM session_folders AS folder
                JOIN subtree ON folder.parent_id = subtree.id
                WHERE folder.namespace = $namespace
            )
            DELETE FROM session_folders WHERE namespace = $namespace AND id IN (SELECT id FROM subtree)
        `).run({ namespace, id }).changes > 0
    }

    copyAssignmentForMerge(namespace: string, sourceId: string, targetId: string): void {
        this.db.query(`
            INSERT INTO session_folder_assignments (session_id, namespace, folder_id)
            SELECT $targetId, namespace, folder_id
            FROM session_folder_assignments
            WHERE namespace = $namespace AND session_id = $sourceId
              AND EXISTS (SELECT 1 FROM sessions WHERE id = $targetId AND namespace = $namespace)
            ON CONFLICT (session_id) DO NOTHING
        `).run({ namespace, sourceId, targetId })
    }

    setAssignment(namespace: string, sessionId: string, folderId: string | null): boolean {
        if (folderId === null) {
            this.db.query('DELETE FROM session_folder_assignments WHERE namespace = ? AND session_id = ?')
                .run(namespace, sessionId)
            return true
        }

        return this.db.query(`
            INSERT INTO session_folder_assignments (session_id, namespace, folder_id)
            SELECT $sessionId, $namespace, $folderId
            WHERE EXISTS (SELECT 1 FROM sessions WHERE id = $sessionId AND namespace = $namespace)
              AND EXISTS (SELECT 1 FROM session_folders WHERE namespace = $namespace AND id = $folderId)
            ON CONFLICT (session_id) DO UPDATE SET folder_id = excluded.folder_id
        `).run({ namespace, sessionId, folderId }).changes > 0
    }
}
