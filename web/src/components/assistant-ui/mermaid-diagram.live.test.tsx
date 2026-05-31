import type React from 'react'
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

const sequenceDiagram = `sequenceDiagram
  participant U as Operator
  participant C as Chat
  participant M as Mermaid
  U->>C: Send message
  C->>M: Render SVG
  U->>M: Click diagram
  M-->>U: Lightbox + zoom`

const defaultComponents = {
    Pre: (props: React.ComponentProps<'pre'>) => <pre {...props} />,
    Code: (props: React.ComponentProps<'code'>) => <code {...props} />,
}

async function expectLightboxShowsDiagram(code: string) {
    installSvgBBoxPolyfill()

    render(
        <I18nProvider>
            <MermaidDiagram
                code={code}
                language="mermaid"
                components={defaultComponents}
            />
        </I18nProvider>,
    )

    await waitFor(
        () => {
            expect(document.querySelector('[data-mermaid-diagram][data-rendered="true"] svg')).toBeTruthy()
        },
        { timeout: 10000 },
    )

    fireEvent.click(document.querySelector('[data-mermaid-diagram][data-rendered="true"]') as HTMLButtonElement)

    await waitFor(
        () => {
            const dialog = screen.getByRole('dialog', { name: 'Diagram' })
            const lightboxSvg = dialog.querySelector('.rounded-lg svg')
            expect(lightboxSvg).toBeTruthy()
            expect(lightboxSvg?.querySelector('path, line, rect')).toBeTruthy()
        },
        { timeout: 10000 },
    )
}

describe('MermaidDiagram live render', () => {
    it(
        'renders real mermaid source to svg in jsdom',
        async () => {
            await expectLightboxShowsDiagram('flowchart LR\n  Hub --> WebUI\n  WebUI --> SVG')
        },
        20_000,
    )

    it(
        'renders sequence diagrams in the lightbox',
        async () => {
            await expectLightboxShowsDiagram(sequenceDiagram)
        },
        20_000,
    )
})
