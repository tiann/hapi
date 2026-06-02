import type { RuntimeStatus } from '../../shared'
import type { Dictionary } from '../i18n'

type Props = {
    status: RuntimeStatus
    dict: Dictionary
    onClick: () => void
}

export function ServiceActionButton({ status, dict, onClick }: Props) {
    const isBusy = status === 'starting' || status === 'stopping'
    const isRunning = status === 'running'
    const label = isRunning ? dict.homePage.stop : dict.homePage.start
    return (
        <button className={isRunning ? 'primary-button stop-button' : 'primary-button'} type="button" onClick={onClick} disabled={isBusy}>
            {isBusy ? formatBusyLabel(status, dict) : label}
        </button>
    )
}

function formatBusyLabel(status: RuntimeStatus, dict: Dictionary): string {
    return status === 'stopping' ? dict.status.stopping : dict.status.starting
}
