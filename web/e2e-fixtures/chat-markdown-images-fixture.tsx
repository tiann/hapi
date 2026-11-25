import ReactDOM from 'react-dom/client'
import type { ApiClient } from '../src/api/client'
import { MarkdownRenderer } from '../src/components/MarkdownRenderer'
import { HappyChatProvider, type HappyChatContextValue } from '../src/components/AssistantChat/context'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../src/components/ui/dialog'
import { I18nProvider } from '../src/lib/i18n-context'
import '../src/index.css'

const SVG_CONTENT = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="160"><rect width="480" height="160" rx="20" fill="#0f766e"/><text x="24" y="92" fill="white" font-family="Arial" font-size="32">chat local image</text></svg>'
const SVG_BASE64 = btoa(SVG_CONTENT)
const REMOTE_IMAGE_URL = new URL('/favicon.ico', window.location.origin).href
const CONTENT = `# Chat Markdown image fixture

[![Local chart](images/chart.svg)](report.md)

![Remote chart](${REMOTE_IMAGE_URL})

![Blocked chart](/outside/secret.png)`

const API = {
    readSessionFile: async (_sessionId: string, path: string, _maxBytes?: number) => {
        if (path === 'images/chart.svg') {
            return { success: true, content: SVG_BASE64, size: SVG_CONTENT.length }
        }
        return { success: false, error: 'outside workspace' }
    },
} as unknown as ApiClient

const chatValue: HappyChatContextValue = {
    api: API,
    sessionId: 'fixture-session',
    metadata: { path: '/workspace', host: 'fixture' },
    terminalToolDisplayMode: 'compact',
    showSessionSummaryInChat: false,
    disabled: false,
    onRefresh: () => {},
    hasMoreMessages: false,
    isSyncingTail: false,
    isLoadingMoreMessages: false,
    loadOlderMessagesPreservingScroll: async () => 'loaded',
}

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

ReactDOM.createRoot(root).render(
    <I18nProvider>
        <HappyChatProvider value={chatValue}>
            <MarkdownRenderer content={CONTENT} />
            <Dialog>
                <DialogTrigger asChild>
                    <button type="button" className="mt-6 rounded-md border border-white/20 px-3 py-2">
                        Open tool detail
                    </button>
                </DialogTrigger>
                <DialogContent className="max-h-56 overflow-auto" aria-describedby={undefined}>
                    <DialogHeader className="text-left">
                        <DialogTitle>Tool detail</DialogTitle>
                    </DialogHeader>
                    <div className="max-h-24 overflow-auto">
                        <MarkdownRenderer content="![Dialog chart](images/chart.svg)" />
                    </div>
                </DialogContent>
            </Dialog>
        </HappyChatProvider>
    </I18nProvider>
)
