import { Spinner } from '@/components/Spinner'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

type LoadingStateProps = {
    label?: string
    className?: string
    spinnerSize?: 'sm' | 'md' | 'lg'
}

export function LoadingState({
    label,
    className,
    spinnerSize = 'md'
}: LoadingStateProps) {
    const { t } = useTranslation()
    const displayLabel = label ?? t('loading')

    return (
        <div
            className={cn('inline-flex items-center gap-2 text-[var(--app-hint)]', className)}
            role="status"
            aria-live="polite"
        >
            <Spinner size={spinnerSize} label={null} />
            <span>{displayLabel}</span>
        </div>
    )
}
