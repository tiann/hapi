import { homedir } from 'node:os';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * agy 1.5.5 can put an earlier turn's error in a successful turn's result.
 * Its native SQLite trajectory stores error_message as step_type 17. Check for
 * the exact same error before this turn and reject any current error step.
 * If the DB/schema is unavailable, preserve the reported failure.
 */
export async function isHistoricalAgyError(conversationId: string, userStep: number, error: string): Promise<boolean> {
    if (!UUID.test(conversationId) || !Number.isSafeInteger(userStep) || userStep <= 0 || !error.trim()) return false;
    try {
        const { Database } = await import('bun:sqlite');
        const db = new Database(join(homedir(), '.gemini', 'antigravity-cli', 'conversations', `${conversationId}.db`), { readonly: true });
        try {
            const prior = db.query('SELECT 1 FROM steps WHERE idx < ? AND step_type = 17 AND instr(step_payload, CAST(? AS BLOB)) > 0 LIMIT 1')
                .get(userStep, error);
            const current = db.query('SELECT 1 FROM steps WHERE idx >= ? AND (step_type = 17 OR status = 7) LIMIT 1')
                .get(userStep);
            return Boolean(prior) && !current;
        } finally { db.close(); }
    } catch {
        return false;
    }
}
