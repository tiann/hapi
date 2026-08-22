import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
    ModelEffortSettingsSection,
    resolveComposerEffortOptions,
    resolveVisibleModelEffortSelectedValue
} from './HappyComposer';

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key === 'misc.variant' ? 'Variant' : key
    })
}));

describe('resolveVisibleModelEffortSelectedValue', () => {
    const newBaseOptions = [
        { value: 'claude-opus-4-8', label: 'Opus' },
        { value: 'claude-opus-4-8[fast=true]', label: 'Opus Fast' }
    ];

    it('keeps session variant when it is still among visible options', () => {
        expect(resolveVisibleModelEffortSelectedValue({
            options: newBaseOptions,
            selectedModelVariant: 'claude-opus-4-8[fast=true]',
            cursorDrillDownDefaultVariant: 'claude-opus-4-8',
            model: 'claude-opus-4-8'
        })).toBe('claude-opus-4-8[fast=true]');
    });

    it('ignores stale session variant after multi-variant base switch', () => {
        // Previous base left selectedModelVariant=composer-2.5-fast; new drill-down
        // already applied claude-opus-4-8 as default while parent state lags.
        expect(resolveVisibleModelEffortSelectedValue({
            options: newBaseOptions,
            selectedModelVariant: 'composer-2.5-fast',
            cursorDrillDownDefaultVariant: 'claude-opus-4-8',
            model: 'composer-2.5'
        })).toBe('claude-opus-4-8');
    });
});

describe('resolveComposerEffortOptions', () => {
    // haiku is the one Claude catalog row with no
    // supportedEffortLevels at all, so the composer's effort options for it
    // must resolve to "only Auto selectable" rather than the full static
    // level list -- otherwise the picker keeps offering effort: 'high' etc.
    // for a model that rejects it.
    it('renders only Auto for Claude when the live catalog reports zero supported levels (haiku)', () => {
        expect(resolveComposerEffortOptions({
            agentFlavor: 'claude',
            effort: null,
            availableEffortOptions: []
        })).toEqual([
            { value: null, label: 'Auto' }
        ]);
    });

    it('renders the live catalog levels for Claude when the selected model supports some', () => {
        expect(resolveComposerEffortOptions({
            agentFlavor: 'claude',
            effort: null,
            availableEffortOptions: [
                { value: 'low', name: 'Low' },
                { value: 'high', name: 'High' }
            ]
        })).toEqual([
            { value: null, label: 'Auto' },
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
        ]);
    });

    it('falls back to the static full-level list for Claude while the catalog has not loaded (availableEffortOptions undefined)', () => {
        const result = resolveComposerEffortOptions({
            agentFlavor: 'claude',
            effort: null,
            availableEffortOptions: undefined
        });
        expect(result[0]).toEqual({ value: null, label: 'Auto' });
        expect(result.length).toBeGreaterThan(1);
    });

    it('keeps Grok on its existing "Default" label and dynamic-list behavior', () => {
        expect(resolveComposerEffortOptions({
            agentFlavor: 'grok',
            effort: null,
            availableEffortOptions: [{ value: 'high', name: 'High' }]
        })).toEqual([
            { value: null, label: 'Default' },
            { value: 'high', label: 'High' }
        ]);
    });
});

describe('ModelEffortSettingsSection', () => {
    it('renders Cursor variant choices and marks the selected variant', () => {
        render(
            <ModelEffortSettingsSection
                agentFlavor="cursor"
                options={[
                    { value: 'composer-2.5', label: 'Composer 2.5' },
                    { value: 'composer-2.5-fast', label: 'Composer 2.5 Fast' }
                ]}
                selectedValue="composer-2.5"
                controlsDisabled={false}
                onChange={() => {}}
            />
        );

        expect(screen.getByText('Variant')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^Composer 2.5$/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Composer 2.5 Fast/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^Composer 2.5$/ }).innerHTML).toContain('bg-[var(--app-link)]');
    });
});
