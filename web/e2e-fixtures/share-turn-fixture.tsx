import { useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { ShareTurnDialog } from '../src/components/AssistantChat/ShareTurnDialog'
import { getUserBubbleClassName } from '../src/components/AssistantChat/messages/user-bubble'
import { MarkdownRenderer } from '../src/components/MarkdownRenderer'
import { I18nProvider } from '../src/lib/i18n-context'

const fixtureImage = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="480" height="240" viewBox="0 0 480 240">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#7c3aed"/><stop offset="1" stop-color="#06b6d4"/></linearGradient></defs>
        <rect width="480" height="240" rx="28" fill="url(#g)"/>
        <circle cx="90" cy="120" r="52" fill="white" fill-opacity=".85"/>
        <text x="165" y="112" fill="white" font-family="system-ui" font-size="28" font-weight="700">HAPI export</text>
        <text x="165" y="148" fill="white" font-family="system-ui" font-size="18">image attachment fixture</text>
    </svg>
`)

const markdown = `## Complex response fixture

This paragraph contains **bold text**, *emphasis*, ~~strikethrough~~, inline \`code\`, a [safe link](https://example.com), 中文内容，以及一段足够长的文字，用于验证换行、行高和宽屏导出效果是否与原始 HAPI 页面保持一致。

> A multi-line blockquote used to verify borders, indentation, colors, and wrapping.  \n> 第二行引用包含中文。

### Lists

- First unordered item
  - Nested item with \`inline code\`
- Second unordered item with a deliberately long sentence that must wrap without being clipped on narrow preview surfaces.

1. First ordered item
2. Second ordered item

| Feature | Desktop | Mobile export |
| --- | ---: | ---: |
| Markdown | ✅ | ✅ |
| Wide code | 960px | 960px |
| Dark theme | ✅ | ✅ |

\`\`\`typescript
type ExportResult = { width: number; theme: 'light' | 'dark'; content: string[] }
const result: ExportResult = { width: 960, theme: 'dark', content: ['markdown', 'table', 'image', 'long-code-line-that-must-not-disappear-from-the-right-hand-side'] }
console.log(result)
\`\`\`

---

Final paragraph after the divider.
`

if (new URLSearchParams(window.location.search).get('theme') === 'dark') {
    document.documentElement.dataset.theme = 'dark'
}

type Snapshot = { html: string; text: string }

function App() {
    const sourceRef = useRef<HTMLDivElement>(null)
    const [snapshots, setSnapshots] = useState<Snapshot[]>([])
    const [open, setOpen] = useState(false)

    const openShare = () => {
        const searchParams = new URLSearchParams(window.location.search)
        const textOnlyUserFallback = searchParams.get('fallback') === 'user'
        const includeToolOnlySnapshot = searchParams.get('toolOnly') === 'assistant'
        const messages = Array.from(sourceRef.current?.children ?? [])
            .filter((node): node is HTMLElement => node instanceof HTMLElement)
            .map((node, index) => ({
                html: textOnlyUserFallback && index === 0 ? '' : node.outerHTML,
                text: node.innerText,
                role: index === 0 ? 'user' as const : 'assistant' as const
            }))
        if (includeToolOnlySnapshot) {
            messages.push({
                html: '<div data-hapi-message-role="assistant"><div data-hapi-share-exclude="true">TOOL_ONLY_SECRET_SHOULD_NOT_EXPORT</div></div>',
                text: 'TOOL_ONLY_SECRET_SHOULD_NOT_EXPORT',
                role: 'assistant'
            })
        }
        setSnapshots(messages)
        setOpen(true)
    }

    return (
        <I18nProvider>
            <main className="mx-auto w-[960px] max-w-full bg-[var(--app-bg)] p-5 text-[var(--app-fg)]">
                <div ref={sourceRef} data-testid="source-turn" className="flex flex-col gap-3">
                    <div data-hapi-message-role="user" className="happy-message flex flex-col items-end">
                        <div className={getUserBubbleClassName()}>
                            <div className="happy-chat-text whitespace-pre-wrap">
                                <span className="mr-1 inline-flex rounded-full bg-[var(--app-chat-user-chip-bg)] px-2 py-px text-[var(--app-chat-user-chip-fg)]">plan</span>
                                {'请导出这一轮复杂对话，并确保代码、表格、图片附件和长文本的样式全部保留。\n第二行用于验证换行。'}
                            </div>
                            <img className="mt-3 max-h-60 rounded-xl" src={fixtureImage} alt="HAPI export fixture" />
                        </div>
                    </div>
                    <div data-hapi-message-role="assistant" className="happy-message share-turn-network-style px-1 min-w-0 max-w-full overflow-x-hidden">
                        <MarkdownRenderer content={markdown} standalone />
                        <div data-hapi-share-exclude="true" className="mt-3 rounded-xl border p-3">Excluded tool output</div>
                    </div>
                </div>
                <button type="button" className="mt-6 rounded-md bg-[var(--app-button)] px-4 py-2 text-[var(--app-button-text)]" onClick={openShare}>
                    Open share preview
                </button>
            </main>
            <ShareTurnDialog
                isOpen={open}
                title="Complex HAPI turn"
                subtitle="Markdown · attachment · code · table"
                sourceSnapshots={snapshots}
                onClose={() => setOpen(false)}
            />
        </I18nProvider>
    )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
