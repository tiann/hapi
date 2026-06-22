import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModelEffortSettingsSection } from './HappyComposer';

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key === 'misc.variant' ? 'Variant' : key
    })
}));

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
        expect(screen.getByRole('button', { name: /^Composer 2.5$/ }).querySelector('.bg-\[var\(--app-link\)\]')).not.toBeNull();
    });
});
