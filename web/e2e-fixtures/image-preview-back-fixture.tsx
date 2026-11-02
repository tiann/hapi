import React, { StrictMode, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { ImagePreview } from '../src/components/ImagePreview'
import { MessageAttachments } from '../src/components/AssistantChat/messages/MessageAttachments'
import { getScrollRestorationKey } from '../src/lib/scrollRestorationKey'
import '../src/index.css'

const previewUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#1769aa"/></svg>')}`

function Conversation() {
    const [draft, setDraft] = useState('')
    const [showAttachment, setShowAttachment] = useState(true)
    return (
        <main className="flex h-full flex-col">
            <h1>Conversation</h1>
            <button data-testid="navigate-away" onClick={() => void router.navigate({ to: '/sessions' })}>Session list</button>
            <div data-testid="conversation-scroll" data-scroll-restoration-id="conversation" className="min-h-0 flex-1 overflow-y-auto">
                <div style={{ height: 1000 }}>Earlier messages</div>
                <section aria-label="Sent images">
                    <MessageAttachments attachments={['first.png', 'second.png'].map((filename) => ({
                        id: filename, filename, mimeType: 'image/png', size: 1, path: `/${filename}`, previewUrl,
                    }))} />
                </section>
                <div style={{ height: 1000 }}>Later messages</div>
            </div>
            <section aria-label="Composer images">
                {showAttachment && <ImagePreview src={previewUrl} fileName="draft.png" label="Draft image" galleryId="composer-attachments" buttonClassName="h-16 w-24" />}
                <button onClick={() => setShowAttachment(false)} data-testid="remove-draft">Remove draft image</button>
            </section>
            <textarea aria-label="Draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
        </main>
    )
}

const root = createRootRoute({ component: Outlet })
const list = createRoute({ getParentRoute: () => root, path: '/sessions', component: () => (
    <main>
        <h1>Session list</h1>
        <button onClick={() => void router.navigate({ to: '/sessions/$sessionId', params: { sessionId: 'one' } })}>Open conversation</button>
    </main>
) })
const conversation = createRoute({ getParentRoute: () => root, path: '/sessions/$sessionId', component: Conversation })
const history = createBrowserHistory()
history.replace('/sessions')
history.flush()
const router = createRouter({
    routeTree: root.addChildren([list, conversation]),
    history,
    scrollRestoration: true,
    getScrollRestorationKey,
})

// Use real browser history and the production scroll-restoration policy.
// StrictMode also exercises blocker registration and cleanup twice.
ReactDOM.createRoot(document.getElementById('root')!).render(<StrictMode><RouterProvider router={router} /></StrictMode>)
