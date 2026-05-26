import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ScheduleTimePicker } from './ScheduleTimePicker'

describe('ScheduleTimePicker interactions', () => {
    it('submits the specific datetime when Enter is pressed in the datetime input', () => {
        const anchorRef = { current: document.createElement('button') }
        const onSchedule = vi.fn()
        const onClose = vi.fn()
        const future = new Date(Date.now() + 60 * 60 * 1000)
        const pad = (n: number) => String(n).padStart(2, '0')
        const value = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}`

        const onParentKeyDown = vi.fn()

        render(
            <I18nProvider>
                <div onKeyDown={onParentKeyDown}>
                    <ScheduleTimePicker
                        anchorRef={anchorRef}
                        onSchedule={onSchedule}
                        onClose={onClose}
                        pendingSchedule={null}
                    />
                </div>
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: /specific/i }))
        const input = screen.getByDisplayValue('')
        fireEvent.change(input, { target: { value } })

        const defaultNotPrevented = fireEvent.keyDown(input, { key: 'Enter' })

        expect(defaultNotPrevented).toBe(false)
        expect(onParentKeyDown).not.toHaveBeenCalled()
        expect(onSchedule).toHaveBeenCalledWith({ type: 'absolute', ms: new Date(value).getTime() })
        expect(onClose).toHaveBeenCalledTimes(1)
    })
})
