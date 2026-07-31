import { describe, expect, it } from 'vitest';
import {
    cursorCliSkuBaseId,
    findBestCliSkuForAcpWire,
    isCursorAcpWireModelId,
    matchCliSkuToAcpWireId,
    parseCursorAvailableModelsFromRejection,
    remapStaleCursorModelId
} from './cursorCliSku';

const cursorGrokCatalog = [
    { modelId: 'cursor-grok-4.5-low' },
    { modelId: 'cursor-grok-4.5-medium' },
    { modelId: 'cursor-grok-4.5-high' },
    { modelId: 'cursor-grok-4.5-low-fast' },
    { modelId: 'cursor-grok-4.5-medium-fast' },
    { modelId: 'cursor-grok-4.5-high-fast' },
];

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

    it('maps base-only SKU to fast=false when fast variants exist (cursor CLI convention)', () => {
        expect(matchCliSkuToAcpWireId('composer-2.5', available)).toBe('composer-2.5[fast=false]');
    });

    it('still maps base-only SKU when only one variant exists', () => {
        expect(matchCliSkuToAcpWireId('composer-2.5', [{ modelId: 'composer-2.5[fast=true]' }])).toBe(
            'composer-2.5[fast=true]'
        );
    });

    it('remaps stale grok ACP wires onto live cursor-grok CLI skus', () => {
        expect(matchCliSkuToAcpWireId('grok-4.5[fast=false]', cursorGrokCatalog)).toBe(
            'cursor-grok-4.5-medium'
        );
        expect(matchCliSkuToAcpWireId('grok-4.5[fast=true]', cursorGrokCatalog)).toBe(
            'cursor-grok-4.5-medium-fast'
        );
    });

    it('rejects unavailable explicit SKU variants when no ACP wires exist', () => {
        expect(matchCliSkuToAcpWireId('gpt-5.5-high', [{ modelId: 'gpt-5.5-medium' }])).toBeNull();
    });
});

describe('remapStaleCursorModelId', () => {
    it('returns exact catalog matches unchanged', () => {
        expect(remapStaleCursorModelId('cursor-grok-4.5-medium', cursorGrokCatalog)).toBe(
            'cursor-grok-4.5-medium'
        );
    });

    it('maps legacy grok wires using fast hints', () => {
        expect(remapStaleCursorModelId('grok-4.5[fast=false]', cursorGrokCatalog)).toBe(
            'cursor-grok-4.5-medium'
        );
        expect(remapStaleCursorModelId('grok-4.5[fast=true]', cursorGrokCatalog)).toBe(
            'cursor-grok-4.5-medium-fast'
        );
    });

    it('returns null when no catalog candidate matches', () => {
        expect(remapStaleCursorModelId('grok-4.5[fast=false]', [{ modelId: 'composer-2.5' }])).toBeNull();
    });

    it('remaps when cache still lists the stale legacy wire alongside live CLI skus', () => {
        expect(
            remapStaleCursorModelId('grok-4.5[fast=false]', [
                { modelId: 'grok-4.5[fast=false]' },
                { modelId: 'cursor-grok-4.5-medium' },
                { modelId: 'cursor-grok-4.5-medium-fast' },
            ])
        ).toBe('cursor-grok-4.5-medium');
    });

    it('prefers any fast SKU over slow medium when medium-fast is absent', () => {
        expect(
            remapStaleCursorModelId('grok-4.5[fast=true]', [
                { modelId: 'cursor-grok-4.5-medium' },
                { modelId: 'cursor-grok-4.5-high-fast' },
            ])
        ).toBe('cursor-grok-4.5-high-fast');
    });
});

describe('parseCursorAvailableModelsFromRejection', () => {
    it('parses comma-separated ids from stderr', () => {
        expect(
            parseCursorAvailableModelsFromRejection(
                'Cannot use this model: grok-4.5[fast=true]. Available models: auto, cursor-grok-4.5-high-fast, composer-2.5'
            )
        ).toEqual(['cursor-grok-4.5-high-fast', 'composer-2.5']);
    });

    it('stops at Tip text on the same line as Available models', () => {
        expect(
            parseCursorAvailableModelsFromRejection(
                'Cannot use this model: grok-4.5[fast=true]. Available models: cursor-grok-4.5-medium Tip: run agent --list-models'
            )
        ).toEqual(['cursor-grok-4.5-medium']);
    });

    it('does not consume following lines after Available models', () => {
        expect(
            parseCursorAvailableModelsFromRejection(
                'Cannot use this model: grok-4.5[fast=true]. Available models: cursor-grok-4.5-high-fast\nTip: use --list-models for full catalog'
            )
        ).toEqual(['cursor-grok-4.5-high-fast']);
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

    it('prefers base-only sku for fast=false wire over -fast sku', () => {
        const wire = 'composer-2.5[fast=false]';
        const best = findBestCliSkuForAcpWire(wire, ['composer-2.5', 'composer-2.5-fast']);
        expect(best).toBe('composer-2.5');
    });

    it('prefers -fast sku for fast=true wire over base-only sku', () => {
        const wire = 'composer-2.5[fast=true]';
        const best = findBestCliSkuForAcpWire(wire, ['composer-2.5', 'composer-2.5-fast']);
        expect(best).toBe('composer-2.5-fast');
    });
});

describe('round-trip (regression for #883: "selected but no response")', () => {
    const acpWires = [
        { modelId: 'composer-2.5[fast=true]' },
        { modelId: 'composer-2.5[fast=false]' }
    ];
    const pickerSkus = ['composer-2.5', 'composer-2.5-fast'];

    function simulateRoundTrip(clickedSku: string): { sessionModel: string; radioOn: string | null } {
        // CLI side: applyCursorAcpModel → resolveCursorAcpWireId → matchCliSkuToAcpWireId
        const sessionModel = matchCliSkuToAcpWireId(clickedSku, acpWires);
        if (!sessionModel) {
            throw new Error('CLI rejected sku');
        }
        // Web side after refetch: cursorVariantSelectValue uses findBestCliSkuForAcpWire
        const radioOn = findBestCliSkuForAcpWire(sessionModel, pickerSkus);
        return { sessionModel, radioOn };
    }

    it('clicking composer-2.5 (slow) lands on the slow radio, not the fast one', () => {
        const result = simulateRoundTrip('composer-2.5');
        expect(result.sessionModel).toBe('composer-2.5[fast=false]');
        expect(result.radioOn).toBe('composer-2.5');
    });

    it('clicking composer-2.5-fast lands on the fast radio', () => {
        const result = simulateRoundTrip('composer-2.5-fast');
        expect(result.sessionModel).toBe('composer-2.5[fast=true]');
        expect(result.radioOn).toBe('composer-2.5-fast');
    });

    it('clicking each picker option lands on a distinct session model (no collapse)', () => {
        const slow = simulateRoundTrip('composer-2.5').sessionModel;
        const fast = simulateRoundTrip('composer-2.5-fast').sessionModel;
        expect(slow).not.toBe(fast);
    });
});

describe('isCursorAcpWireModelId', () => {
    it('detects wire ids', () => {
        expect(isCursorAcpWireModelId('gpt-5.5[fast=false]')).toBe(true);
        expect(isCursorAcpWireModelId('gpt-5.5-high-fast')).toBe(false);
    });
});
