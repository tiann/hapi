import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const toastVariants = cva(
    'pointer-events-auto w-full max-w-sm rounded-xl border text-[var(--app-fg)] shadow-lg transition-all',
    {
        variants: {
            variant: {
                default: 'border-[var(--app-border)] bg-[var(--app-bg)]',
                success: 'border-emerald-500/35 bg-emerald-50 text-emerald-950 shadow-emerald-500/10 ring-1 ring-emerald-500/15 dark:bg-emerald-950 dark:text-emerald-50'
            }
        },
        defaultVariants: {
            variant: 'default'
        }
    }
)

const toastActionVariants = cva(
    'mt-2 inline-flex w-fit items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1',
    {
        variants: {
            variant: {
                default: 'bg-[var(--app-secondary-bg)] text-[var(--app-fg)] ring-[var(--app-border)]',
                success: 'bg-white/90 text-emerald-700 ring-emerald-500/20 dark:bg-emerald-900/80 dark:text-emerald-200'
            }
        },
        defaultVariants: {
            variant: 'default'
        }
    }
)

export type ToastProps = React.HTMLAttributes<HTMLDivElement> &
    VariantProps<typeof toastVariants> & {
    title: string
    body: string
    actionLabel?: string
    onClose?: () => void
}

function ArrowRightIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M5 12h14" />
            <path d="m12 5 7 7-7 7" />
        </svg>
    )
}

export function Toast({ title, body, actionLabel, onClose, className, variant, ...props }: ToastProps) {
    const handleClose = (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation()
        onClose?.()
    }

    return (
        <div className={cn(toastVariants({ variant }), className)} role="status" {...props}>
            <div className="relative p-3 pr-10">
                <div className="min-w-0">
                    <div className="text-sm font-semibold leading-5">{title}</div>
                    <div className="mt-1 text-xs leading-5 text-[var(--app-hint)]">{body}</div>
                    {actionLabel ? (
                        <div className={toastActionVariants({ variant })}>
                            <span>{actionLabel}</span>
                            <ArrowRightIcon className="h-3.5 w-3.5" />
                        </div>
                    ) : null}
                </div>
                {onClose ? (
                    <button
                        type="button"
                        className="absolute right-3 top-3 text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                        onClick={handleClose}
                        aria-label="Dismiss"
                    >
                        x
                    </button>
                ) : null}
            </div>
        </div>
    )
}
