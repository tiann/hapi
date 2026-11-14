import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useNavigate } from '@tanstack/react-router'
import { AppContextProvider } from '../src/lib/app-context'
import { I18nProvider } from '../src/lib/i18n-context'
import { useTranslation } from '../src/lib/use-translation'
import { ToastProvider } from '../src/lib/toast-context'
import { initializeTheme } from '../src/hooks/useTheme'
import { SessionListSearch } from '../src/components/SessionList'
import { ConversationOutlinePanel } from '../src/components/AssistantChat/HappyThread'
import SettingsGeneralPage from '../src/routes/settings/general'
import FilesPage from '../src/routes/sessions/files'
import { useAppGoBack } from '../src/hooks/useAppGoBack'
import type { ApiClient } from '../src/api/client'
import '../src/index.css'

initializeTheme()

// Production inputs, settings and file routes; only data/preview contents are fixtures.
const session = {
    id: 'fixture', active: true, activeAt: 1000, updatedAt: 1000,
    metadata: { path: '/workspace/project', name: '搜索历史演示', flavor: 'codex' },
}
const api = {
    getSession: async () => ({ session }),
    getMachines: async () => ({ machines: [] }),
    getGitStatus: async () => ({ success: true, stdout: '' }),
    getGitDiffNumstat: async () => ({ success: true, stdout: '' }),
    getScratchlist: async () => ({ entries: [] }),
    listSessionDirectory: async () => ({ success: true, entries: [] }),
    searchSessionFiles: async (_id: string, query: string) => ({ success: true, files:
        ['README.md', 'src/main.ts', 'src/中文.ts'].filter(path => path.includes(query.replace('*', ''))).map(path => ({
            fileName: path.split('/').at(-1), filePath: path.includes('/') ? 'src' : '', fullPath: path, fileType: 'file',
        })),
    }),
} as unknown as ApiClient

function SessionSearch() {
    const { locale } = useTranslation()
    const chinese = locale === 'zh-CN'
    const [value, setValue] = useState('')
    const [expanded, setExpanded] = useState(true)
    return <section className="relative mx-auto max-w-xl p-3" aria-label="Session search fixture">
        <SessionListSearch value={value} onChange={setValue} expanded={expanded} onExpandedChange={setExpanded}
            customStart="" customEnd="" sessionActivityDates={new Set()} onDateRangeChange={() => {}} />
        <p data-fixture-control="" className="mt-4">{chinese ? (value ? `筛选会话：${value}` : '全部会话') : (value ? `Filtered sessions: ${value}` : 'All sessions')}</p>
        <button data-fixture-control="" type="button" className="min-h-11" onClick={() => setExpanded(true)}>{chinese ? '聚焦会话搜索' : 'Focus session search'}</button>
    </section>
}
function Outline() {
    const { locale } = useTranslation()
    const chinese = locale === 'zh-CN'
    const [open, setOpen] = useState(true)
    return <div className="relative h-[500px]">
        <button data-fixture-control="" type="button" onClick={() => setOpen(true)}>{chinese ? '打开大纲' : 'Open outline'}</button>
        {open && <ConversationOutlinePanel items={[
            { id: 'one', targetMessageId: 'one', label: chinese ? '实现搜索历史功能' : 'Implement history', kind: 'user', createdAt: 1000 },
            { id: 'two', targetMessageId: 'two', label: chinese ? '测试中文输入法' : 'Test 中文 input', kind: 'user', createdAt: 2000 },
        ]} hasMoreMessages={false} isLoadingMoreMessages={false} onLoadMore={() => {}} onSelect={() => setOpen(false)} onClose={() => setOpen(false)} />}
    </div>
}
function Preview() {
    const back = useAppGoBack()
    return <section><h1>File preview</h1><button type="button" onClick={back}>Return to files</button></section>
}
function Shell() {
    const { locale } = useTranslation()
    const labels: Record<string, string> = { Sessions: '会话', Files: '文件', Outline: '大纲', Settings: '设置' }
    const navigate = useNavigate()
    return <main className="min-h-screen bg-[var(--app-bg)] text-[var(--app-fg)]">
        <nav className="flex flex-wrap gap-3 border-b p-3">
            {[
                ['Sessions', '/sessions'], ['Files', '/sessions/fixture/files'], ['Outline', '/outline'], ['Settings', '/settings/general'],
            ].map(([label, to]) => <button key={label} type="button" className="min-h-11" onClick={() => navigate({ to })}>{locale === 'zh-CN' ? labels[label] : label}</button>)}
        </nav>
        <Outlet />
    </main>
}
const root = createRootRoute({ component: Shell })
const files = createRoute({ getParentRoute: () => root, path: '/sessions/$sessionId/files', component: FilesPage, validateSearch: (search: Record<string, unknown>) => search })
const preview = createRoute({ getParentRoute: () => root, path: '/sessions/$sessionId/file', component: Preview, validateSearch: (search: Record<string, unknown>) => search })
const router = createRouter({
    routeTree: root.addChildren([
        createRoute({ getParentRoute: () => root, path: '/sessions', component: SessionSearch }),
        files, preview,
        createRoute({ getParentRoute: () => root, path: '/outline', component: Outline }),
        createRoute({ getParentRoute: () => root, path: '/settings/general', component: SettingsGeneralPage }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/sessions'] }),
})
function Fixture() {
    const params = new URLSearchParams(location.search)
    const token = `x.${btoa(JSON.stringify({ uid: Number(params.get('uid') ?? 1), ns: params.get('ns') ?? 'fixture', exp: params.get('exp') ?? '1' }))}.x`
    return <AppContextProvider value={{ api, token, baseUrl: params.get('hub') ?? location.origin }}>
        <RouterProvider router={router} />
    </AppContextProvider>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider><I18nProvider><Fixture /></I18nProvider></ToastProvider>
    </QueryClientProvider>
</React.StrictMode>)
