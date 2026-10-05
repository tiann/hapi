import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { SidebarResizeHandle, SidebarShowButton } from '../src/components/SidebarToggle'

function Harness() {
    const [sidebarVisible, setSidebarVisible] = useState(true)

    return (
        <div className="flex h-screen min-h-0 bg-[var(--app-bg)]">
            {sidebarVisible ? (
                <>
                    <aside className="flex w-80 shrink-0 items-center justify-center border-r border-[var(--app-border)]">
                        Session list
                    </aside>
                    <SidebarResizeHandle
                        canHide={true}
                        hideLabel="Hide session list"
                        onHide={() => setSidebarVisible(false)}
                        onPointerDown={() => {}}
                    />
                </>
            ) : null}
            <main className="relative flex min-w-0 flex-1 items-center justify-center">
                {!sidebarVisible ? (
                    <SidebarShowButton
                        showLabel="Show session list"
                        onShow={() => setSidebarVisible(true)}
                    />
                ) : null}
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
