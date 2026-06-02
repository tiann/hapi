import type { ConsoleLogEntry, LauncherConfig, RuntimeState } from '../../shared'
import { ConsoleLog } from '../components/ConsoleLog'
import { ServiceActionButton } from '../components/ServiceActionButton'
import type { Dictionary } from '../i18n'

type Props = {
    config: LauncherConfig
    state: RuntimeState
    logs: ConsoleLogEntry[]
    dict: Dictionary
    onServiceAction: () => void
    onClearLogs: () => void
}

export function HomePage({ config, state, logs, dict, onServiceAction, onClearLogs }: Props) {
    return (
        <div className="page-content home-page-content">
            <div className="top-grid">
                <section className="card hero-card">
                    <h2>{getTitle(state.status, dict)}</h2>
                    <p>{state.status === 'running' ? dict.homePage.runningText : dict.homePage.idleText}</p>
                    <ServiceActionButton status={state.status} dict={dict} onClick={onServiceAction} />
                </section>
                <section className="card settings-info-card">
                    <h2>{dict.homePage.settingsInfo}</h2>
                    <div className="info-row"><span>{dict.homePage.directories}</span><strong>{dict.homePage.directoryCount.replace('{count}', String(config.workspaceRoots.length))}</strong></div>
                    <div className="info-row"><span>{dict.homePage.port}</span><strong>{config.hubPort}</strong></div>
                    <div className="info-row"><span>{dict.homePage.relay}</span><strong>{config.relayEnabled ? dict.homePage.relayOn : dict.homePage.relayOff}</strong></div>
                </section>
            </div>
            <ConsoleLog logs={logs} dict={dict} onClear={onClearLogs} />
        </div>
    )
}

function getTitle(status: RuntimeState['status'], dict: Dictionary): string {
    if (status === 'running') return dict.homePage.running
    if (status === 'starting') return dict.homePage.starting
    if (status === 'stopping') return dict.homePage.stopping
    if (status === 'error') return dict.homePage.error
    return dict.homePage.notRunning
}
