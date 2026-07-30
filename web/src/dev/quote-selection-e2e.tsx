import { createRoot } from 'react-dom/client'
import { useCallback, useRef, useState } from 'react'
import { QuoteSelectionPopover } from '@/components/AssistantChat/QuoteSelectionPopover'
import { QuoteChips } from '@/components/AssistantChat/QuoteChips'
import { QuoteHighlights } from '@/components/AssistantChat/QuoteHighlights'
import { useQuoteSelection, type QuotableSelection } from '@/hooks/useQuoteSelection'
import { useComposerQuotes } from '@/lib/use-composer-quotes'
import { serializeQuotes } from '@/lib/quotes'
import { I18nProvider } from '@/lib/i18n-context'
import '@/index.css'

function Harness() {
    const containerRef = useRef<HTMLDivElement | null>(null)
    const { selection, clear } = useQuoteSelection(containerRef)
    const quotes = useComposerQuotes('e2e-session')
    const [body, setBody] = useState('')
    const [activeQuoteId, setActiveQuoteId] = useState<string | null>(null)

    const handleQuote = useCallback((picked: QuotableSelection) => {
        quotes.add(picked.text, picked.messageId)
        clear()
    }, [quotes, clear])

    return (
        <div style={{ padding: 24, maxWidth: 900 }}>
            <div ref={containerRef} className="happy-thread-messages relative flex flex-col gap-4">
                <div className="happy-message" id="msg-1">
                    <p>The converter passes unknown SDK message types straight through to the renderer.</p>
                </div>
                <div className="happy-message" id="msg-2">
                    <p>Do not delete the normalize fallback. It is a deliberate last line of defence.</p>
                </div>
                {/* 必须和真实应用一样挂在消息容器内：角标是相对该容器绝对定位的 */}
                <QuoteHighlights
                    quotes={quotes.quotes}
                    containerRef={containerRef}
                    activeQuoteId={activeQuoteId}
                />
            </div>
            <QuoteChips
                quotes={quotes.quotes}
                onRemove={quotes.remove}
                onJump={() => {}}
                activeQuoteId={activeQuoteId}
                onHover={setActiveQuoteId}
            />
            <textarea
                data-testid="body-input"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                style={{ width: '100%', minHeight: 60, marginTop: 12 }}
            />
            <pre data-testid="serialized">{serializeQuotes(quotes.quotes, body)}</pre>
            <QuoteSelectionPopover selection={selection} onQuote={handleQuote} />
        </div>
    )
}

createRoot(document.getElementById('root')!).render(
    <I18nProvider><Harness /></I18nProvider>
)
