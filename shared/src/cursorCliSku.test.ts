import { describe, expect, it } from 'vitest';
import {
    cursorCliSkuBaseId,
    findBestCliSkuForAcpWire,
    isCursorAcpWireModelId,
    matchCliSkuToAcpWireId
} from './cursorCliSku';

describe('cursorCliSkuBaseId', () => {
    it('strips effort/speed suffixes from CLI skus', () => {
        expect(cursorCliSkuBaseId('gpt-5.5-high-fast')).toBe('gpt-5.5');
        expect(cursorCliSkuBaseId('composer-2.5-fast')).toBe('composer-2.5');
        expect(cursorCliSkuBaseId('gpt-5.3-codex-xhigh-fast')).toBe('gpt-5.3-codex');
    });

    it('keeps wire base ids unchanged', () => {
        expect(cursorCliSkuBaseId('composer-2.5[fast=true]')).toBe('composer-2.5');
    });
});

describe('matchCliSkuToAcpWireId', () => {
    const available = [
        { modelId: 'composer-2.5[fast=true]' },
        { modelId: 'composer-2.5[fast=false]' },
        { modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]' }
    ];

    it('returns exact wire matches', () => {
        expect(matchCliSkuToAcpWireId('composer-2.5[fast=false]', available)).toBe('composer-2.5[fast=false]');
    });

    it('maps CLI skus onto the matching ACP wire for the same base', () => {
        expect(matchCliSkuToAcpWireId('composer-2.5-fast', available)).toBe('composer-2.5[fast=true]');
        expect(matchCliSkuToAcpWireId('gpt-5.5-medium', available)).toBe('gpt-5.5[context=272k,reasoning=medium,fast=false]');
    });

    it('picks the best wire when multiple ACP variants exist', () => {
        expect(matchCliSkuToAcpWireId('composer-2.5', available)).toBe('composer-2.5[fast=true]');
    });
});

describe('findBestCliSkuForAcpWire', () => {
    it('picks the sku that best matches wire params, not the first partial match', () => {
        const wire = 'gpt-5.5[context=272k,reasoning=medium,fast=false]';
        const best = findBestCliSkuForAcpWire(wire, [
            'gpt-5.5-high-fast',
            'gpt-5.5-medium',
            'gpt-5.5-low'
        ]);
        expect(best).toBe('gpt-5.5-medium');
    });
});

describe('isCursorAcpWireModelId', () => {
    it('detects wire ids', () => {
        expect(isCursorAcpWireModelId('gpt-5.5[fast=false]')).toBe(true);
        expect(isCursorAcpWireModelId('gpt-5.5-high-fast')).toBe(false);
    });
});
