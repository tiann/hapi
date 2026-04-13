import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { Badge } from '@/components/ui/badge'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { parseExitPlanModeInput, isExitPlanImplementationMode, getExitPlanImplementationModeDescription, getExitPlanImplementationModeLabel } from '@/components/ToolCard/exitPlanMode'
import { useTranslation } from '@/lib/use-translation'

export function ExitPlanModeView(props: ToolViewProps) {
    const { t } = useTranslation()
    const { plan } = parseExitPlanModeInput(props.block.tool.input)
    const permission = props.block.tool.permission
    const implementationMode = isExitPlanImplementationMode(permission?.implementationMode)
        ? permission.implementationMode
        : null
    const fallbackReason = permission?.status === 'denied'
        ? t('tool.exitPlanMode.denied')
        : permission?.status === 'canceled'
            ? t('tool.exitPlanMode.canceled')
            : null
    const denialReason = permission?.reason ?? fallbackReason

    if (!plan && !implementationMode && !denialReason) return null

    return (
        <div className="flex flex-col gap-3">
            {plan ? (
                <div>
                    <MarkdownRenderer content={plan} />
                </div>
            ) : null}

            {implementationMode ? (
                <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
                    <div className="flex items-center gap-2">
                        <Badge variant="default">
                            {t('tool.exitPlanMode.selected')}
                        </Badge>
                    </div>
                    <div className="mt-2 text-sm font-medium text-[var(--app-fg)]">
                        {getExitPlanImplementationModeLabel(implementationMode, t)}
                    </div>
                    <div className="mt-1 text-xs text-[var(--app-hint)]">
                        {getExitPlanImplementationModeDescription(implementationMode, t)}
                    </div>
                </div>
            ) : null}

            {(permission?.status === 'denied' || permission?.status === 'canceled') && denialReason ? (
                <div className="text-xs text-red-600">
                    {denialReason}
                </div>
            ) : null}
        </div>
    )
}
