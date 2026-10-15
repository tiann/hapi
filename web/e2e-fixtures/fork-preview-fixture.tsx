/*
 * Standalone Vite-served fixture for the fork preview Playwright spec
 * (scratchlist pattern). Mounts the production ForkPreviewDialog inside
 * an I18nProvider with a stub confirm callback on `window.__forkPreviewE2E`
 * so the spec can assert dialog rendering, the boundary marker, and that
 * cancel/confirm route to the right callback without the hub stack.
 */

import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import { ForkPreviewDialog } from '../src/components/AssistantChat/ForkPreviewDialog'
import type { ForkPreviewTurn } from '../src/lib/forkPreview'

declare global {
    interface Window {
        __forkPreviewE2E?: {
            confirmed: number
            cancelled: number
        }
    }
}

const KEPT_TURNS: ForkPreviewTurn[] = [
    { role: 'user', text: 'first question about pagination' },
    { role: 'assistant', text: 'first answer explaining the boundary' },
    { role: 'user', text: 'second question about forking' },
]

function Fixture() {
    const [open, setOpen] = useState(true)
    return (
        <ForkPreviewDialog
            isOpen={open}
            kind="historical"
            keptTurns={KEPT_TURNS}
            boundaryText="third question — not copied into the new session"
            onCancel={() => {
                window.__forkPreviewE2E!.cancelled += 1
                setOpen(false)
            }}
            onConfirm={async () => {
                window.__forkPreviewE2E!.confirmed += 1
                setOpen(false)
            }}
        />
    )
}

window.__forkPreviewE2E = { confirmed: 0, cancelled: 0 }
ReactDOM.createRoot(document.getElementById('root')!).render(
    <I18nProvider>
        <Fixture />
    </I18nProvider>
)
