import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { PermissionField } from './PermissionField'

function renderField(props: Partial<Parameters<typeof PermissionField>[0]> = {}) {
    return render(
        <I18nProvider>
            <PermissionField
                agent="claude"
                nativeValue="default"
                yoloMode={false}
                isDisabled={false}
                onNativeChange={vi.fn()}
                onYoloToggle={vi.fn()}
                {...props}
            />
        </I18nProvider>
    )
}

describe('PermissionField', () => {
    it('renders native permission modes for codex-family agents', () => {
        const onChange = vi.fn()
        renderField({ agent: 'copilot', nativeValue: 'default', onNativeChange: onChange })
        expect(screen.getByRole('combobox')).toBeTruthy()
        expect(screen.getByRole('option', { name: 'Yolo' })).toBeTruthy()
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'yolo' } })
        expect(onChange).toHaveBeenCalledWith('yolo')
    })

    it('offers Auto when Grok advertises the account feature', () => {
        renderField({ agent: 'grok', autoPermissionModeSupported: true })
        expect(screen.getByRole('option', { name: 'Auto' })).not.toBeDisabled()
    })

    it('shows Auto as unavailable when Grok does not advertise it', () => {
        renderField({ agent: 'grok', autoPermissionModeSupported: false })
        expect(screen.getByRole('option', { name: 'Auto (unavailable)' })).toBeDisabled()
        expect(screen.getByText(/did not enable Auto permissions/i)).toBeInTheDocument()
    })

    it('renders the YOLO toggle with its native mapping for toggle flavors', () => {
        renderField({ agent: 'claude' })
        expect(screen.getByRole('checkbox')).toBeTruthy()
        expect(screen.getByText(/applies native Yolo mode/i)).toBeInTheDocument()
    })

    it('maps agy YOLO to its native always-proceed mode', () => {
        renderField({ agent: 'agy' })
        expect(screen.getByText(/applies native Always Proceed mode/i)).toBeInTheDocument()
    })

    it('reports Pi permission as managed instead of offering a silent YOLO toggle', () => {
        const { container } = renderField({ agent: 'pi' })
        expect(screen.getByTestId('permission-managed')).toBeTruthy()
        expect(screen.getByText(/managed by agent/i)).toBeInTheDocument()
        expect(screen.queryByRole('checkbox')).toBeNull()
        expect(screen.queryByRole('combobox')).toBeNull()
        expect(container.firstChild).not.toBeNull()
    })
})
