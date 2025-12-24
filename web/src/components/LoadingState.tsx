import { Spinner } from '@/components/Spinner'
import { cn } from '@/lib/utils'

type LoadingStateProps = {
    label?: string
    className?: string
    spinnerSize?: 'sm' | 'md' | 'lg'
}

export function LoadingState({
    label = 'Loading…',
    className,
    spinnerSize = 'md'
}: LoadingStateProps) {
    return (
        <div
            className={cn('inline-flex items-center gap-2 text-[var(--app-hint)]', className)}
            role="status"
            aria-live="polite"
        >
            <Spinner size={spinnerSize} label={null} />
            <span>{label}</span>
        </div>
    )
}
