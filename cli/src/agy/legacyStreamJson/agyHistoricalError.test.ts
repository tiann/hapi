import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('historical agy errors', () => {
    it('requires a complete current trajectory in the same SQLite snapshot', () => {
        // Run against Bun's actual SQLite implementation, not a query mock.
        const script = `
            import { Database } from 'bun:sqlite';
            import { mkdtempSync, rmSync } from 'node:fs';
            import { join } from 'node:path';
            import { tmpdir } from 'node:os';
            import { isHistoricalAgyError } from './src/agy/legacyStreamJson/agyHistoricalError';
            const dir = mkdtempSync(join(tmpdir(), 'agy-error-test-'));
            const path = join(dir, 'conversation.db');
            const id = '12345678-1234-4234-8234-123456789abc';
            const db = new Database(path);
            try {
                db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)');
                const insert = db.query('INSERT INTO steps VALUES (?, ?, ?, ?)');
                const check = () => isHistoricalAgyError(id, 2, 4, 'quota exceeded', 'answer', path);
                insert.run(1, 17, 3, Buffer.from('quota exceeded'));
                const missingCurrent = await check();
                insert.run(2, 14, 3, Buffer.from('question'));
                const missingAnswer = await check();
                insert.run(4, 15, 3, Buffer.from('answer'));
                const complete = await check();
                const trailingNewline = await isHistoricalAgyError(id, 2, 4, 'quota exceeded', 'answer\\n', path);
                const differentAnswer = await isHistoricalAgyError(id, 2, 4, 'quota exceeded', 'different', path);
                insert.run(5, 17, 3, Buffer.from('current failure'));
                const currentError = await check();
                console.log(JSON.stringify({ missingCurrent, missingAnswer, complete, trailingNewline, differentAnswer, currentError }));
            } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
        `;
        const child = spawnSync('bun', ['-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 });
        expect(child.status, child.stderr).toBe(0);
        expect(JSON.parse(child.stdout.trim())).toEqual({
            missingCurrent: false, missingAnswer: false, complete: true, trailingNewline: true, differentAnswer: false, currentError: false,
        });
    });
});
