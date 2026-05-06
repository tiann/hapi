import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { CodeBlock } from '@/components/CodeBlock'

describe('CodeBlock', () => {
    it('renders a header label and truncation badge for long content', () => {
        const longCode = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n')
        const { container } = render(
            <I18nProvider>
                <CodeBlock
                    code={longCode}
                    language="typescript"
                    title="TypeScript"
                    collapseLongContent
                    collapseLineThreshold={5}
                />
            </I18nProvider>
        )

        expect(screen.getByText('TypeScript')).toBeInTheDocument()
        expect(screen.getByTitle('Copy')).toBeInTheDocument()
        expect(screen.getByText(/Preview truncated/)).toBeInTheDocument()
        expect(container.querySelector('[style*="grid-template-columns: 3ch max-content"]')).not.toBeNull()
        expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(/^1 2 3/)
    })
})
