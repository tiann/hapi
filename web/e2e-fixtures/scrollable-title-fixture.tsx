import React from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { ScrollableSurface, ScrollableTitle } from '../src/components/ScrollableTitle'

const SESSION_TITLE = 'HAPI 状态插件开发 - 移动端详情页完整标题横向查看'
const FILE_NAME = 'hapi-machine-status.v0.70.0-before-restore-v0.69.0.user.js'
const FILE_PATH = 'machine-status-widget/userscripts/hapi-machine-status.user.js'

function ScrollableTitleFixture() {
    return (
        <main style={{ width: '280px', margin: '0 auto', padding: '16px' }}>
            <section data-testid="session-title-surface">
                <ScrollableTitle
                    text={SESSION_TITLE}
                    className="font-semibold"
                    testId="session-title"
                />
            </section>
            <section data-testid="file-title-surface" style={{ marginTop: '24px' }}>
                <ScrollableTitle
                    text={FILE_NAME}
                    className="font-semibold"
                    testId="file-title"
                />
                <ScrollableTitle
                    text={FILE_PATH}
                    className="text-xs text-[var(--app-hint)]"
                    testId="file-path"
                />
            </section>
            <section data-testid="metadata-surface" style={{ marginTop: '24px' }}>
                <ScrollableSurface
                    ariaLabel="Session metadata"
                    contentClassName="flex items-center gap-2"
                    testId="metadata"
                    resetKey="codex|machine|model|reasoning|fast|branch"
                >
                    <span className="shrink-0">codex</span>
                    <span className="shrink-0">machine: NUC</span>
                    <span className="shrink-0">model: gpt-5.4</span>
                    <span className="shrink-0">reasoning xhigh</span>
                    <span className="shrink-0 text-[#34C759]">fast</span>
                    <span className="shrink-0">feature/mobile-title-scroll</span>
                </ScrollableSurface>
            </section>
        </main>
    )
}

const rootElement = document.getElementById('root')
if (rootElement) {
    ReactDOM.createRoot(rootElement).render(
        <React.StrictMode>
            <ScrollableTitleFixture />
        </React.StrictMode>
    )
}
