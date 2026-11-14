import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { SessionActionMenu } from '../src/components/SessionActionMenu'
import { SidebarShowButton } from '../src/components/SidebarToggle'
import { I18nProvider } from '../src/lib/i18n-context'

function Harness() {
    const [sidebarVisible, setSidebarVisible] = useState(
        new URLSearchParams(window.location.search).get('sidebar') !== 'hidden'
    )

    return (
        <I18nProvider>
            <div className="relative flex h-screen min-h-0 bg-[var(--app-bg)]">
                {sidebarVisible ? (
                    <aside data-testid="session-list" className="flex w-80 shrink-0 items-center justify-center border-r border-[var(--app-border)]">
                        Session list
                    </aside>
                ) : null}
                <main className="relative flex min-w-0 flex-1 items-center justify-center">
                    {!sidebarVisible ? (
                        <SidebarShowButton
                            showLabel="Show session list"
                            onShow={() => setSidebarVisible(true)}
                        />
                    ) : null}
                    <span>Session detail</span>
                </main>
                {sidebarVisible ? (
                    <SessionActionMenu
                        isOpen={true}
                        onClose={() => {}}
                        sessionId="session-123"
                        sessionTitle="Fixture session"
                        sessionActive={true}
                        onRename={() => {}}
                        onArchive={() => {}}
                        onDelete={() => {}}
                        anchorPoint={{ x: 100, y: 100 }}
                    />
                ) : null}
            </div>
        </I18nProvider>
    )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <Harness />
    </React.StrictMode>
)
