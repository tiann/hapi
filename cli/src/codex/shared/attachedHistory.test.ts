import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AttachedHistoryChangedError, validateAttachedHistory } from './attachedHistory';

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function checkpoint() {
    const home = await mkdtemp(join(tmpdir(), 'hapi-attached-history-')); homes.push(home);
    return join(home, 'checkpoints', 'history.json');
}
const turn = (id: string, text = id, status = 'completed') => ({ id, status, items: [{ id, type: 'agentMessage', text }] });

describe('attached completed-history checkpoint', () => {
    it('accepts appends and changing in-progress items, sealing terminal content privately', async () => {
        const file = await checkpoint();
        await validateAttachedHistory(file, { turns: [turn('a'), turn('b', 'partial', 'inProgress')] });
        await validateAttachedHistory(file, { turns: [turn('a'), turn('b', 'more', 'inProgress')] });
        expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([expect.objectContaining({ id: 'a', hash: expect.any(String) }), { id: 'b', hash: null }]);
        await validateAttachedHistory(file, { turns: [turn('a'), turn('b'), turn('c', 'stopped', 'interrupted')] });
        expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(3);
        expect((await stat(file)).mode & 0o777).toBe(0o600);
    });
    it('does not forget a turn observed before detaching midway through generation', async () => {
        const file = await checkpoint();
        await validateAttachedHistory(file, { turns: [turn('a'), turn('b', 'partial', 'inProgress')] });
        await expect(validateAttachedHistory(file, { turns: [turn('a')] })).rejects.toBeInstanceOf(AttachedHistoryChangedError);
    });
    it.each(['truncate', 'rewrite', 'reorder', 'replace'] as const)('refuses %s, including mutations missed while detached', async kind => {
        const file = await checkpoint();
        await validateAttachedHistory(file, { turns: [turn('a'), turn('b')] });
        const turns = { truncate: [turn('a')], rewrite: [turn('a', 'edited'), turn('b')],
            reorder: [turn('b'), turn('a')], replace: [turn('a'), turn('new')] }[kind];
        await expect(validateAttachedHistory(file, { turns })).rejects.toBeInstanceOf(AttachedHistoryChangedError);
        expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(2);
    });
    it('fails closed on malformed native history and corrupt checkpoint files', async () => {
        const file = await checkpoint();
        await expect(validateAttachedHistory(file, {})).rejects.toThrow('verify');
        await expect(validateAttachedHistory(file, { turns: [{ id: 'a', status: 'completed' }] })).rejects.toThrow('verify');
        await expect(validateAttachedHistory(file, { turns: [turn('a'), turn('a')] })).rejects.toThrow('Ambiguous');
        await validateAttachedHistory(file, { turns: [turn('a')] });
        await writeFile(file, '{');
        await expect(validateAttachedHistory(file, { turns: [turn('a')] })).rejects.toThrow();
        expect(await readFile(file, 'utf8')).toBe('{');
    });
});
