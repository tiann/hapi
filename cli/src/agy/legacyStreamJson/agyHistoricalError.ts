import { homedir } from 'node:os';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Evidence = { prior: number; prompt: number; response: number; nextPrompt: number; currentError: number };

/**
 * agy 1.5.5 can put an earlier turn's error in a successful turn's result.
 * Only suppress it when one SQLite snapshot contains the exact earlier error,
 * this turn's user input and completed matching answer, and no current error.
 * Missing or lagging trajectory data must leave the failure visible.
 */
export async function isHistoricalAgyError(
    conversationId: string, userStep: number, responseStep: number, error: string, response: string,
    databasePath = join(homedir(), '.gemini', 'antigravity-cli', 'conversations', `${conversationId}.db`)
): Promise<boolean> {
    if (!UUID.test(conversationId) || !Number.isSafeInteger(userStep) || userStep <= 0
        || !Number.isSafeInteger(responseStep) || responseStep <= userStep || !error.trim() || !response.trim()) return false;
    try {
        const { Database } = await import('bun:sqlite');
        const db = new Database(databasePath, { readonly: true });
        try {
            // agy 1.5.5 native steps: user_input=14, agent_response=15,
            // error_message=17, DONE=3 and ERROR=7. Unknown schemas fail closed.
            const row = db.query(`SELECT
                EXISTS(SELECT 1 FROM steps WHERE idx < ?1 AND step_type = 17 AND instr(step_payload, CAST(?3 AS BLOB)) > 0) AS prior,
                EXISTS(SELECT 1 FROM steps WHERE idx = ?1 AND step_type = 14 AND status = 3) AS prompt,
                EXISTS(SELECT 1 FROM steps WHERE idx = ?2 AND step_type = 15 AND status = 3 AND instr(step_payload, CAST(?4 AS BLOB)) > 0) AS response,
                EXISTS(SELECT 1 FROM steps WHERE idx > ?1 AND idx <= ?2 AND step_type = 14) AS nextPrompt,
                EXISTS(SELECT 1 FROM steps WHERE idx >= ?1 AND (step_type = 17 OR status = 7)) AS currentError`)
                .get(userStep, responseStep, error, response.trim()) as Evidence | null;
            return Boolean(row?.prior && row.prompt && row.response && !row.nextPrompt && !row.currentError);
        } finally { db.close(); }
    } catch {
        return false;
    }
}
