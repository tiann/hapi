import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { CodexFamilyPermissionModeSelector } from './CodexFamilyPermissionModeSelector'

function renderSelector(props: Parameters<typeof CodexFamilyPermissionModeSelector>[0]) {
    return render(
        <I18nProvider>
            <CodexFamilyPermissionModeSelector {...props} />
        </I18nProvider>
    )
}

describe('CodexFamilyPermissionModeSelector', () => {
    it('renders permission modes for copilot', () => {
        const { container } = renderSelector({
            agent: 'copilot',
            value: 'default',
            isDisabled: false,
            onChange: vi.fn(),
        })
        expect(screen.getByRole('combobox')).toHaveClass('appearance-none', 'pr-10')
        expect(container.querySelector('svg[aria-hidden="true"]')).toBeTruthy()
        expect(screen.getByRole('option', { name: 'Yolo' })).toBeTruthy()
    })

    it('hides for claude', () => {
        const { container } = renderSelector({
            agent: 'claude',
            value: 'default',
            isDisabled: false,
            onChange: vi.fn(),
        })
        expect(container.firstChild).toBeNull()
    })

    it('calls onChange when a mode is selected', () => {
        const onChange = vi.fn()
        renderSelector({
            agent: 'copilot',
            value: 'default',
            isDisabled: false,
            onChange,
        })
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'yolo' } })
        expect(onChange).toHaveBeenCalledWith('yolo')
    })
})
