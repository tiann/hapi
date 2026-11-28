import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { useSidebarResize } from '../src/hooks/useSidebarResize'
import { SidebarResizeHandle, SidebarShowButton, useSidebarToggleFocus } from '../src/components/SidebarToggle'

function Harness() {
    const [sidebarVisible, setSidebarVisible] = useState(true)
    const sidebar = useSidebarResize()
    const toggleFocus = useSidebarToggleFocus()

    return (
        <div className="flex h-screen min-h-0 bg-[var(--app-bg)]">
            {sidebarVisible ? (
                <>
                    <aside style={{ '--sidebar-w': `${sidebar.width}px` } as React.CSSProperties} className="flex shrink-0 items-center justify-center border-r border-[var(--app-border)]">
                        Session list
                    </aside>
                    <SidebarResizeHandle
                        canHide={true}
                        hideLabel="Hide session list"
                        onHide={() => setSidebarVisible(false)}
                        toggleFocus={toggleFocus}
                        isDragging={sidebar.isDragging}
                        onPointerDown={sidebar.onPointerDown}
                    />
                </>
            ) : null}
            <main className="relative flex min-w-0 flex-1 items-center justify-center">
                {!sidebarVisible ? (
                    <SidebarShowButton
                        showLabel="Show session list"
                        toggleFocus={toggleFocus}
                        onShow={() => setSidebarVisible(true)}
                    />
                ) : null}
                <div className="absolute left-3 top-1/2 -translate-y-1/2 font-mono" data-testid="terminal-first-column">$ echo terminal</div>
                Session detail
            </main>
        </div>
    )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <Harness />
    </React.StrictMode>
)
