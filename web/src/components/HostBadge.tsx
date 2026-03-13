import { cn } from '@/lib/utils'
import { getHostColorStyle, getHostDisplayName } from '@/lib/host-utils'
import { useTranslation } from '@/lib/use-translation'

type HostBadgeProps = {
    displayName?: string
    host?: string
    machineId?: string
    sessionId?: string
    className?: string
    showBoth?: boolean
}

export function HostBadge({ displayName, host, machineId, sessionId, className, showBoth = false }: HostBadgeProps) {
    const { t } = useTranslation()

    const shortMachineId = machineId?.slice(0, 8)
    const label = showBoth && host && shortMachineId
        ? `${host}(${shortMachineId})`
        : getHostDisplayName({ displayName, host, machineId, sessionId })
    const colorStyle = label ? getHostColorStyle(label) : null

    if (!label || !colorStyle) return null

    const ariaLabel = `${t('session.item.hostPrefix')} ${label}`

    return (
        <span
            className={cn(
                'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium leading-tight whitespace-nowrap border',
                className
            )}
            style={{
                backgroundColor: colorStyle.backgroundColor,
                color: colorStyle.color,
                borderColor: colorStyle.borderColor,
            }}
            title={label}
            role="status"
            aria-label={ariaLabel}
        >
            <span aria-hidden="true">{t('session.item.hostPrefix')}</span>
            <span aria-hidden="true">{label}</span>
        </span>
    )
}
