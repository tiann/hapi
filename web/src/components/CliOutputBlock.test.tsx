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
})
