import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_ROW_TOOLTIP_FOCUS_CLASS } from '@/components/HoverTooltip'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionPrChip } from './SessionPrChip'

afterEach(() => cleanup())

describe('SessionPrChip keyboard wiring', () => {
    it('reveals nested chip tooltips on session-row focus-visible', () => {
        render(
            <I18nProvider>
                <SessionPrChip
                    interactive={false}
                    refs={[{
                        kind: 'github_pr',
                        repo: 'tiann/hapi',
                        number: 1163,
                        url: 'https://github.com/tiann/hapi/pull/1163',
                        role: 'primary'
                    }]}
                />
            </I18nProvider>
        )

        const tooltip = screen.getByRole('tooltip', { hidden: true })
        for (const token of SESSION_ROW_TOOLTIP_FOCUS_CLASS.split(/\s+/)) {
            expect(tooltip.className).toContain(token)
        }
    })
})
