import { useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { ShareTurnDialog } from '../src/components/AssistantChat/ShareTurnDialog'
import { getUserBubbleClassName, UserBubbleContent } from '../src/components/AssistantChat/messages/user-bubble'
import { MarkdownRenderer } from '../src/components/MarkdownRenderer'
import { I18nProvider } from '../src/lib/i18n-context'
import { useSessionHeaderMetadata } from '../src/hooks/useSessionHeaderMetadata'
import { selectShareTurnMetadata } from '../src/lib/shareTurnMetadata'

const fixtureImage = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="480" height="240" viewBox="0 0 480 240">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#7c3aed"/><stop offset="1" stop-color="#06b6d4"/></linearGradient></defs>
        <rect width="480" height="240" rx="28" fill="url(#g)"/>
        <circle cx="90" cy="120" r="52" fill="white" fill-opacity=".85"/>
        <text x="165" y="112" fill="white" font-family="system-ui" font-size="28" font-weight="700">HAPI export</text>
        <text x="165" y="148" fill="white" font-family="system-ui" font-size="18">image attachment fixture</text>
    </svg>
`)

const portraitFixtureImage = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="240" height="420" viewBox="0 0 240 420">
        <rect width="240" height="420" rx="28" fill="#0f766e"/>
        <text x="120" y="190" text-anchor="middle" fill="white" font-family="system-ui" font-size="24" font-weight="700">Portrait</text>
        <text x="120" y="226" text-anchor="middle" fill="white" font-family="system-ui" font-size="16">attachment</text>
    </svg>
`)

const longInlineError =
    'useClientLookup: Index 0 out of bounds (length: 0); messageStore.getMessagesPage -> useSessionMessageWindow -> SessionChat render -> message epoch mismatch after rewind; requestId=rewind-20260812-162035; source=codex-session-history-replay; retry=0; snapshotHeadSeq=4; nextBeforeSeq=null; invariant=visible-message-window-consistency'

const markdown = `## Complex response fixture

## ✅ AList 的 frp 和 Caddy 配置已彻底移除

This paragraph contains **bold text**, *emphasis*, ~~strikethrough~~, inline \`code\`, a [safe link](https://example.com), 中文内容，以及一段足够长的文字，用于验证换行、行高和宽屏导出效果是否与原始 HAPI 页面保持一致。

已复现：/rewind 返回 200，但随后前端进入错误页。错误为 \`${longInlineError}\`，Console 也有完整堆栈；我正在整理脱敏后的证据文件和截图。

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

\`alist.techotaku39.top\` 已失效，5244 端口也不再监听。

请将 \`machine-status-widget/hapi-machine-status.user.js\` 全文覆盖到油猴脚本中，然后强制刷新页面。
`

if (new URLSearchParams(window.location.search).get('theme') === 'dark') {
    document.documentElement.dataset.theme = 'dark'
}

type Snapshot = { html: string; text: string }

function App() {
    const sourceRef = useRef<HTMLDivElement>(null)
    const [snapshots, setSnapshots] = useState<Snapshot[]>([])
    const [open, setOpen] = useState(false)
    const searchParams = new URLSearchParams(window.location.search)
    const wideSource = searchParams.get('wide') === '1'
    const narrowInlineSource = searchParams.get('inlineWrap') === '1'
    const { preferences: headerMetadata } = useSessionHeaderMetadata()
    const metadataItems = selectShareTurnMetadata(headerMetadata, {
        agent: { text: 'codex', flavor: 'codex' },
        machine: { text: `${headerMetadata.showLabels ? 'Machine: ' : ''}fixture-host` },
        lastActive: { text: '2 minutes ago' },
        model: { text: `${headerMetadata.showLabels ? 'Model: ' : ''}gpt-5.6-sol` },
        reasoning: { text: `${headerMetadata.showLabels ? 'Reasoning: ' : ''}high` },
        fastMode: { text: 'fast' },
        createdAt: { text: `${headerMetadata.showLabels ? 'Created: ' : ''}Aug 2, 2026, 10:00 AM` },
        updatedAt: { text: `${headerMetadata.showLabels ? 'Updated: ' : ''}Aug 2, 2026, 10:30 AM` },
        worktree: { text: `${headerMetadata.showLabels ? 'Worktree: ' : ''}feat/share-turn-polish` },
    })

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
            <main className={`mx-auto max-w-full bg-[var(--app-bg)] p-5 text-[var(--app-fg)] ${narrowInlineSource ? 'w-[865px]' : wideSource ? 'w-[1120px]' : 'w-[960px]'}`}>
                <div ref={sourceRef} data-testid="source-turn" className="flex flex-col gap-3">
                    <div data-hapi-message-role="user" className="happy-message flex flex-col items-end">
                        <div className={getUserBubbleClassName()}>
                            <UserBubbleContent text={'这个失败不用说吧：`bun run test` was also attempted. The Web suite passes, but the complete repository run is currently blocked on Windows by unrelated tests.\n第二行用于验证换行。'} />
                            <div className="hapi-share-media-grid mt-3 flex flex-wrap gap-2" data-hapi-image-count="2">
                                <button type="button" title="Click to zoom" data-image-preview-trigger="" data-image-preview-label="HAPI landscape export fixture" className="overflow-hidden rounded-xl">
                                    <img className="max-h-60" src={fixtureImage} alt="HAPI landscape export fixture" />
                                </button>
                                <button type="button" title="Click to zoom" data-image-preview-trigger="" data-image-preview-label="HAPI portrait export fixture" className="overflow-hidden rounded-xl">
                                    <img className="max-h-60" src={portraitFixtureImage} alt="HAPI portrait export fixture" />
                                </button>
                            </div>
                        </div>
                    </div>
                    <div data-hapi-message-role="assistant" className="happy-message share-turn-network-style px-1 min-w-0 max-w-full overflow-x-hidden">
                        <MarkdownRenderer content={markdown} standalone />
                        <p data-testid="before-hidden-tool">Visible content before the hidden tool.</p>
                        <div data-hapi-share-exclude="true" className="mt-3 rounded-xl border p-3">Excluded tool output</div>
                        <p data-testid="after-hidden-tool">Visible content after the hidden tool.</p>
                        <div className="happy-message-actions mt-1 flex h-5 items-center gap-1" data-testid="localized-message-actions">
                            <button type="button" title="已复制" aria-label="已复制">Copied state control</button>
                        </div>
                    </div>
                </div>
                <button type="button" className="mt-6 rounded-md bg-[var(--app-button)] px-4 py-2 text-[var(--app-button-text)]" onClick={openShare}>
                    Open share preview
                </button>
            </main>
            <ShareTurnDialog
                isOpen={open}
                title="Complex HAPI turn"
                metadataItems={metadataItems}
                sourceSnapshots={snapshots}
                sourceContentWidth={sourceRef.current?.getBoundingClientRect().width ?? null}
                onClose={() => setOpen(false)}
            />
        </I18nProvider>
    )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
