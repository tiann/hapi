import type { RuntimeStatus } from '../../shared'
import { formatStatusLabel, type Dictionary } from '../i18n'

type Props = {
    status: RuntimeStatus
    dict: Dictionary
}

export function StatusBadge({ status, dict }: Props) {
    const className = `status-badge status-${status}`
    return <div className={className}>● {formatStatusLabel(status, dict)}</div>
}
