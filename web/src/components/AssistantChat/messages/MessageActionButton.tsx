import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export const MESSAGE_ACTION_BUTTON_CLASS =
    'flex h-5 w-5 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'

type MessageActionButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title'> & {
    label: string
}

export function MessageActionButton({
    label,
    className,
    children,
    type = 'button',
    ...props
}: MessageActionButtonProps) {
    return (
        <button
            {...props}
            type={type}
            title={label}
            aria-label={label}
            className={cn(MESSAGE_ACTION_BUTTON_CLASS, className)}
        >
            {children}
        </button>
    )
}
