import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { record, string } from './gateway';

const SnapshotSchema = z.array(z.object({ id: z.string(), hash: z.string().nullable() }));
const checkpointWrites = new Map<string, Promise<void>>();
export class AttachedHistoryChangedError extends Error {
    constructor() { super('Native history changed outside HAPI; use hapi attach --new-view for a fresh projection'); }
}

/** Durable observed-prefix guard, including rewrites missed while detached. */
export async function validateAttachedHistory(file: string, thread: unknown): Promise<void> {
    // A cancelled replay may still be writing while its replacement validates.
    const write = (checkpointWrites.get(file) ?? Promise.resolve()).catch(() => {})
        .then(() => validateAndWriteCheckpoint(file, thread));
    checkpointWrites.set(file, write);
    try { await write; }
    finally { if (checkpointWrites.get(file) === write) checkpointWrites.delete(file); }
}

async function validateAndWriteCheckpoint(file: string, thread: unknown): Promise<void> {
    const turns = record(thread).turns;
    if (!Array.isArray(turns)) throw new Error('Cannot verify attached native history');
    const current = turns.map(record).map(turn => {
        const id = string(turn.id);
        if (!id || !Array.isArray(turn.items) || !['completed', 'interrupted', 'failed', 'inProgress'].includes(String(turn.status))) {
            throw new Error('Cannot verify native turn');
        }
        // Active items may legitimately change. Fence their turn identity now,
        // and seal their content once terminal, rather than forgetting them
        // when the worker detaches midway through generation.
        return { id, hash: turn.status === 'inProgress' ? null : createHash('sha256').update(JSON.stringify(turn.items)).digest('hex') };
    });
    if (new Set(current.map(turn => turn.id)).size !== current.length) throw new Error('Ambiguous native turn IDs');
    let previous: z.infer<typeof SnapshotSchema> = [];
    try { previous = SnapshotSchema.parse(JSON.parse(await readFile(file, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous.some((turn, index) => current[index]?.id !== turn.id || turn.hash !== null && current[index]?.hash !== turn.hash)) {
        throw new AttachedHistoryChangedError();
    }
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(current), { mode: 0o600 });
    await rename(temporary, file);
}
