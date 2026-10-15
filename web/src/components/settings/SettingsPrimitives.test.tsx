import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SettingsSwitch } from './SettingsPrimitives'

describe('SettingsSwitch dual-pole', () => {
    it('shows both named states as left and right poles', () => {
        render(
            <SettingsSwitch
                label="Theme"
                leftLabel="Light"
                rightLabel="Dark"
                checked={false}
                onChange={vi.fn()}
            />,
        )
        expect(screen.getByRole('button', { name: 'Light' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Dark' })).toBeInTheDocument()
        expect(screen.getByRole('checkbox', { name: 'Theme' })).not.toBeChecked()
    })

    it('selects the right pole when that label is pressed', () => {
        const onChange = vi.fn()
        render(
            <SettingsSwitch
                label="Theme"
                leftLabel="Light"
                rightLabel="Dark"
                checked={false}
                onChange={onChange}
            />,
        )
        fireEvent.click(screen.getByRole('button', { name: 'Dark' }))
        expect(onChange).toHaveBeenCalledWith(true)
    })

    it('selects the left pole when that label is pressed', () => {
        const onChange = vi.fn()
        render(
            <SettingsSwitch
                label="Theme"
                leftLabel="Light"
                rightLabel="Dark"
                checked={true}
                onChange={onChange}
            />,
        )
        fireEvent.click(screen.getByRole('button', { name: 'Light' }))
        expect(onChange).toHaveBeenCalledWith(false)
    })
})
