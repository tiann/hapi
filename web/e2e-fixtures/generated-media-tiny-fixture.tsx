import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import type { ApiClient } from '../src/api/client'
import { I18nProvider } from '../src/lib/i18n-context'
import type { GeneratedImageBlock } from '../src/chat/types'
import { HappyChatProvider, type HappyChatContextValue } from '../src/components/AssistantChat/context'
import { GeneratedImageCard } from '../src/components/AssistantChat/messages/ToolMessage'

// A real 16x32 PNG. Layout geometry cannot be asserted against a jsdom stub,
// so the browser test loads this exact image and measures the rendered box.
const TINY_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAgCAYAAAAbifjMAAAAIklEQVR42mPgn9v/nxLMMGrAqAGjBowaMGrAqAGjBgw3AwCVW3Q9w8nKtgAAAABJRU5ErkJggg=='

const TINY_BLOCK: GeneratedImageBlock = {
    kind: 'generated-image',
    id: 'generated:tiny-16x32',
    localId: 'tiny-16x32',
    createdAt: 1000,
    invokedAt: 1000,
    imageId: 'tiny-16x32',
    fileName: 'tiny-16x32.png',
    mimeType: 'image/png'
}

function tinyPngBlob(): Blob {
    const binary = atob(TINY_PNG_BASE64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index)
    }
    return new Blob([bytes], { type: 'image/png' })
}

const blob = tinyPngBlob()

const api = {
    getGeneratedImageBlob: async () => blob
} as unknown as ApiClient

const context: HappyChatContextValue = {
    api,
    sessionId: 'generated-media-tiny-fixture',
    metadata: null,
    terminalToolDisplayMode: 'detailed',
    showSessionSummaryInChat: false,
    disabled: false,
    onRefresh: () => {},
    hasMoreMessages: false,
    isSyncingTail: false,
    isLoadingMoreMessages: false,
    loadOlderMessagesPreservingScroll: async () => 'terminal-stop'
}

function Fixture() {
    return (
        <HappyChatProvider value={context}>
            <main className="mx-auto flex max-w-3xl flex-col gap-3 p-5">
                <p className="text-xs text-[var(--app-hint)]">
                    Real GeneratedImageCard with a real 16x32 PNG; synthetic session data.
                </p>
                <GeneratedImageCard block={TINY_BLOCK} />
                {/* In normal flow directly after the card. A tiny preview that
                    only paints larger (transform) overflows its own card box and
                    lands on top of this marker instead of pushing it down. */}
                <p data-testid="follower" className="text-sm">
                    Following chat content
                </p>
            </main>
        </HappyChatProvider>
    )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <I18nProvider>
            <Fixture />
        </I18nProvider>
    </StrictMode>
)
