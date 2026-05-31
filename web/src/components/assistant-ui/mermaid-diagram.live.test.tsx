import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MermaidDiagram } from '@/components/assistant-ui/mermaid-diagram'
import { I18nProvider } from '@/lib/i18n-context'

function installSvgBBoxPolyfill() {
    const bbox = () => ({
        x: 0,
        y: 0,
        width: 120,
        height: 24,
        top: 0,
        left: 0,
        right: 120,
        bottom: 24,
        toJSON() {
            return {}
        },
    })

    for (const proto of [Element.prototype, HTMLElement.prototype, SVGElement.prototype]) {
        if (proto && !('getBBox' in proto)) {
            Object.defineProperty(proto, 'getBBox', {
                configurable: true,
                value: bbox,
            })
        }
    }
}

describe('MermaidDiagram live render', () => {
    it('renders real mermaid source to svg in jsdom', async () => {
        installSvgBBoxPolyfill()

        render(
            <I18nProvider>
                <MermaidDiagram
                    code={'flowchart LR\n  Hub --> WebUI\n  WebUI --> SVG'}
                    language="mermaid"
                    components={{
                        Pre: (props) => <pre {...props} />,
                        Code: (props) => <code {...props} />,
                    }}
                />
            </I18nProvider>,
        )

        await waitFor(
            () => {
                const diagram = document.querySelector('[data-mermaid-diagram][data-rendered="true"]')
                expect(diagram).toBeTruthy()
                expect(diagram?.querySelector('svg')).toBeTruthy()
            },
            { timeout: 10000 },
        )

        fireEvent.click(document.querySelector('[data-mermaid-diagram][data-rendered="true"]') as HTMLButtonElement)

        await waitFor(
            () => {
                const dialog = screen.getByRole('dialog', { name: 'Diagram' })
                const img = dialog.querySelector('img')
                expect(img).toBeTruthy()
                expect(img?.getAttribute('src')?.startsWith('data:image/svg+xml')).toBe(true)
                const transform = dialog.querySelector<HTMLElement>('[style*="transform"]')?.style.transform ?? ''
                expect(transform).toMatch(/scale\([^0)]/)
            },
            { timeout: 5000 },
        )
    })
})
