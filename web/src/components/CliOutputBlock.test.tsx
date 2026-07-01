import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { CliOutputBlock } from '@/components/CliOutputBlock'

describe('CliOutputBlock', () => {
    it('does not render a nested copy button inside the preview trigger', () => {
        render(
            <I18nProvider>
                <CliOutputBlock text={'<command-name>npm test</command-name><local-command-stdout>ok</local-command-stdout>'} />
            </I18nProvider>
        )

        expect(screen.getByRole('button', { name: /npm test/i })).toBeInTheDocument()
        expect(screen.queryByTitle('Copy')).not.toBeInTheDocument()
    })

    it('does not render a nested wrap toggle button inside the preview trigger', () => {
        // The preview CodeBlock renders inside a DialogTrigger <button>, so
        // its wrap toggle <button> must be suppressed to avoid nesting
        // interactive elements (invalid HTML / hydration violation).
        render(
            <I18nProvider>
                <CliOutputBlock text={'<command-name>npm test</command-name><local-command-stdout>ok</local-command-stdout>'} />
            </I18nProvider>
        )

        // The wrap toggle is the only button carrying aria-pressed; asserting
        // its absence by role avoids coupling to the localized title.
        expect(screen.queryByRole('button', { pressed: false })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { pressed: true })).not.toBeInTheDocument()
    })
})
