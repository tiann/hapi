import { useEffect, useMemo, useState } from 'react'
import type { ConsoleLogEntry, LauncherConfig, RuntimeState } from '../shared'
import { Sidebar, type Page } from './components/Sidebar'
import { StatusBadge } from './components/StatusBadge'
import { getDictionary, getInitialConfig } from './i18n'
import { HomePage } from './pages/HomePage'
import { SettingsPage } from './pages/SettingsPage'

const INITIAL_STATE: RuntimeState = {
    status: 'stopped',
    error: null,
    hubHealthy: false,
    runnerOnline: false,
    workspaceRootsSynced: false
}

export function App() {
    const [page, setPage] = useState<Page>('home')
    const [config, setConfig] = useState<LauncherConfig>(getInitialConfig())
    const [state, setState] = useState<RuntimeState>(INITIAL_STATE)
    const [logs, setLogs] = useState<ConsoleLogEntry[]>([])
    const dict = useMemo(() => getDictionary(config.locale), [config.locale])

    useEffect(() => {
        void window.hapiDesktop.getConfig().then(setConfig)
        void window.hapiDesktop.getState().then(setState)
        const offState = window.hapiDesktop.onStateChange(setState)
        const offLog = window.hapiDesktop.onLog((entry) => {
            setLogs((current) => [...current.slice(-500), entry])
        })
        return () => {
            offState()
            offLog()
        }
    }, [])

    const saveConfig = async (nextConfig: LauncherConfig) => {
        const saved = await window.hapiDesktop.saveConfig(nextConfig)
        setConfig(saved)
    }

    const handleServiceAction = () => {
        if (state.status === 'running') {
            void window.hapiDesktop.stop()
            return
        }
        void window.hapiDesktop.start()
    }

    const clearLogs = () => {
        setLogs([])
        void window.hapiDesktop.clearLogs()
    }

    return (
        <div className="app-shell">
            <Sidebar activePage={page} dict={dict} openWebEnabled={state.status === 'running'} onNavigate={setPage} onOpenWeb={() => void window.hapiDesktop.openWeb()} />
            <main className="main-pane">
                <header className="topbar">
                    <h1>{page === 'settings' ? dict.settings : dict.home}</h1>
                    <StatusBadge status={state.status} dict={dict} />
                </header>
                {page === 'home' ? (
                    <HomePage config={config} state={state} logs={logs} dict={dict} onServiceAction={handleServiceAction} onClearLogs={clearLogs} />
                ) : (
                    <SettingsPage config={config} runtimeStatus={state.status} dict={dict} onSave={saveConfig} />
                )}
            </main>
        </div>
    )
}
