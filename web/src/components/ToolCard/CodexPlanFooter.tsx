import { useRef, useState } from 'react'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'

/** Codex's plan menu is a client action, independent of native tool approvals. */
export function CodexPlanFooter(props: { planId: string }) {
    const ctx = useOptionalHappyChatContext()
    const { t } = useTranslation()
    const inFlight = useRef(false)
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const available = ctx?.metadata?.flavor === 'codex' && ctx.codexPlanProposalId === props.planId

    if (!ctx || (!available && !pending && !error)) return null

    const implement = async () => {
        if (!available || ctx.disabled || inFlight.current) return
        inFlight.current = true
        setPending(true)
        setError(null)
        try {
            await ctx.api.implementCodexPlan(ctx.sessionId, props.planId)
        } catch (e) {
            setError(e instanceof Error ? e.message : t('tool.requestFailed'))
        } finally {
            inFlight.current = false
            setPending(false)
            ctx.onRefresh()
        }
    }

    return (
        <div className="mt-3 space-y-2">
            {error ? <div role="alert" className="text-sm text-[var(--app-badge-error-text)]">{error}</div> : null}
            {available || pending ? (
                <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={!available || ctx.disabled || pending} aria-busy={pending} onClick={implement}>
                        {pending ? <Spinner size="sm" label={null} /> : null}
                        {t('tool.plan.implement')}
                    </Button>
                    {ctx.onContinuePlan ? (
                        <Button size="sm" variant="outline" disabled={!available || ctx.disabled || pending} onClick={ctx.onContinuePlan}>
                            {t('tool.plan.continue')}
                        </Button>
                    ) : null}
                </div>
            ) : null}
        </div>
    )
}
