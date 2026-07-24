import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
    HoverTooltip,
    SESSION_ROW_TOOLTIP_FOCUS_CLASS,
    useSessionRowTooltipIds
} from './HoverTooltip'

afterEach(() => cleanup())

describe('HoverTooltip keyboard wiring', () => {
    it('sizes short localized tooltips to their content up to the maximum width', () => {
        render(
            <HoverTooltip id="attention-tooltip" target={<span>dot</span>}>
                有新活动
            </HoverTooltip>
        )

        const tooltip = screen.getByRole('tooltip', { hidden: true })
        expect(tooltip.className).toContain('w-max')
        expect(tooltip.className).toContain('max-w-[14rem]')
    })

    it('applies parent row focus-visible reveal classes', () => {
        render(
            <HoverTooltip
                id="sched-tooltip"
                target={<span data-testid="target">icon</span>}
                revealOnParentFocusClass={SESSION_ROW_TOOLTIP_FOCUS_CLASS}
            >
                Scheduled copy
            </HoverTooltip>
        )

        const tooltip = screen.getByRole('tooltip', { hidden: true })
        expect(tooltip.id).toBe('sched-tooltip')
        expect(tooltip.className).toContain('group-focus-visible/session-row:visible')
        expect(tooltip.className).not.toContain('group-focus-within')
    })
})

describe('useSessionRowTooltipIds', () => {
    function Probe(props: { hasAttention: boolean; hasSchedule: boolean }) {
        const { attentionId, scheduleId, describedBy } = useSessionRowTooltipIds(
            props.hasAttention,
            props.hasSchedule
        )
        return (
            <div
                data-testid="probe"
                data-attention={attentionId ?? ''}
                data-schedule={scheduleId ?? ''}
                data-describedby={describedBy ?? ''}
            />
        )
    }

    it('returns both ids and a combined describedBy when both indicators are present', () => {
        render(<Probe hasAttention hasSchedule />)
        const probe = screen.getByTestId('probe')
        const attention = probe.getAttribute('data-attention')
        const schedule = probe.getAttribute('data-schedule')
        expect(attention).toBeTruthy()
        expect(schedule).toBeTruthy()
        expect(probe.getAttribute('data-describedby')).toBe(`${attention} ${schedule}`)
    })

    it('returns undefined describedBy when neither indicator is present', () => {
        render(<Probe hasAttention={false} hasSchedule={false} />)
        expect(screen.getByTestId('probe').getAttribute('data-describedby')).toBe('')
    })
})
