import { describe, expect, it } from 'vitest';
import { validateSpawnModelAgainstCatalog } from './spawnModelCatalog';

const CURSOR_CATALOG = [
    'auto',
    'composer-2.5[thinking]',
    'gpt-5.1[reasoning=high]',
    'cursor-grok-4.5-fast'
];

describe('validateSpawnModelAgainstCatalog', () => {
    it('rejects a model the catalog does not contain and names the accepted ids', () => {
        const result = validateSpawnModelAgainstCatalog('cursor', 'gpt-5', CURSOR_CATALOG);

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.message).toContain("Model 'gpt-5' is not in the cursor model catalog");
        // Cursor wire ids collapse to the base slug the user can actually pass.
        expect(result.ok === false && result.message).toContain('Accepted: gpt-5.1, auto, composer-2.5, cursor-grok-4.5');
    });

    it('accepts an exact catalog id', () => {
        expect(validateSpawnModelAgainstCatalog('cursor', 'gpt-5.1[reasoning=high]', CURSOR_CATALOG)).toEqual({ ok: true });
    });

    it('accepts a Cursor base slug for a parameterized wire id', () => {
        expect(validateSpawnModelAgainstCatalog('cursor', 'composer-2.5', CURSOR_CATALOG)).toEqual({ ok: true });
    });

    it('accepts a Cursor CLI sku whose base is in the catalog', () => {
        expect(validateSpawnModelAgainstCatalog('cursor', 'cursor-grok-4.5-high', CURSOR_CATALOG)).toEqual({ ok: true });
    });

    it('accepts a renamed Cursor base that the stale-model remap would resolve', () => {
        expect(validateSpawnModelAgainstCatalog('cursor', 'grok-4.5', ['cursor-grok-4.5-fast'])).toEqual({ ok: true });
    });

    it('matches catalog ids case-insensitively', () => {
        expect(validateSpawnModelAgainstCatalog('cursor', 'Composer-2.5', CURSOR_CATALOG)).toEqual({ ok: true });
    });

    it('leaves variant-level availability to the handshake', () => {
        // Absence of a variant from a cached catalog is not proof it is gone:
        // shared cliModelSkus rows are partial until a probe unions more in, and
        // that probe is skipped while an ACP session holds the CLI lock. Rejecting
        // here would block valid spawns on any mid-union or wire-only cache.
        expect(validateSpawnModelAgainstCatalog('cursor', 'gpt-5.5-high-fast', ['gpt-5.5-medium'])).toEqual({ ok: true });
        expect(validateSpawnModelAgainstCatalog(
            'cursor',
            'claude-opus-4-8[thinking=false,effort=high]',
            ['claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]']
        )).toEqual({ ok: true });
    });

    it('accepts wildcard ids and no model at all', () => {
        expect(validateSpawnModelAgainstCatalog('cursor', 'auto', CURSOR_CATALOG)).toEqual({ ok: true });
        expect(validateSpawnModelAgainstCatalog('cursor', 'Auto', CURSOR_CATALOG)).toEqual({ ok: true });
        expect(validateSpawnModelAgainstCatalog('cursor', 'default', CURSOR_CATALOG)).toEqual({ ok: true });
        // Bare ACP wire form the spawn path also reads as "let the agent pick".
        expect(validateSpawnModelAgainstCatalog('cursor', 'default[]', CURSOR_CATALOG)).toEqual({ ok: true });
        expect(validateSpawnModelAgainstCatalog('cursor', undefined, CURSOR_CATALOG)).toEqual({ ok: true });
        expect(validateSpawnModelAgainstCatalog('cursor', '   ', CURSOR_CATALOG)).toEqual({ ok: true });
    });

    it('never rejects when the machine could not enumerate a catalog', () => {
        expect(validateSpawnModelAgainstCatalog('cursor', 'gpt-5', [])).toEqual({ ok: true });
        expect(validateSpawnModelAgainstCatalog('claude', 'claude-opus-5', [])).toEqual({ ok: true });
    });

    it('does not apply Cursor sku-suffix stripping to other flavors', () => {
        // agy ships `<model>-<effort>` ids; `-high` is part of the id, not a sku suffix.
        expect(validateSpawnModelAgainstCatalog('agy', 'gemini-3.7-flash-low', ['gemini-3.7-flash-high'])).toEqual({
            ok: false,
            message: "Model 'gemini-3.7-flash-low' is not in the agy model catalog on this machine. Accepted: gemini-3.7-flash-high"
        });
    });

    it('lists near-miss ids before the rest of the catalog', () => {
        const catalog = ['claude-opus-5', 'composer-2.5', 'gpt-5.2', 'gpt-5.5'];
        const result = validateSpawnModelAgainstCatalog('cursor', 'gpt-5', catalog);

        expect(result.ok === false && result.message).toContain('Accepted: gpt-5.2, gpt-5.5, claude-opus-5, composer-2.5');
    });

    it('truncates a long accepted list', () => {
        const catalog = Array.from({ length: 20 }, (_, index) => `model-${index}`);
        const result = validateSpawnModelAgainstCatalog('cursor', 'nope', catalog);

        expect(result.ok === false && result.message).toContain('… (20 total)');
    });
});
