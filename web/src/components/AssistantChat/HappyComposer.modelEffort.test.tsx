import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
    ModelEffortSettingsSection,
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
