import type { ReactNode } from 'react'

type SessionIconProps = {
    className?: string
}

function createSessionIcon(paths: ReactNode, props: SessionIconProps, fill: 'none' | 'currentColor' = 'none') {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill={fill}
            stroke={fill === 'none' ? 'currentColor' : undefined}
            strokeWidth={fill === 'none' ? '2' : undefined}
            strokeLinecap={fill === 'none' ? 'round' : undefined}
            strokeLinejoin={fill === 'none' ? 'round' : undefined}
            className={props.className}
        >
            {paths}
        </svg>
    )
}

export function EditIcon(props: SessionIconProps) {
    return createSessionIcon(
        <>
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            <path d="m15 5 4 4" />
        </>,
        props
    )
}

export function ArchiveIcon(props: SessionIconProps) {
    return createSessionIcon(
        <>
            <rect width="20" height="5" x="2" y="3" rx="1" />
            <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
            <path d="M10 12h4" />
        </>,
        props
    )
}

export function TrashIcon(props: SessionIconProps) {
    return createSessionIcon(
        <>
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            <line x1="10" x2="10" y1="11" y2="17" />
            <line x1="14" x2="14" y1="11" y2="17" />
        </>,
        props
    )
}

export function MoreVerticalIcon(props: SessionIconProps) {
    return createSessionIcon(
        <>
            <circle cx="12" cy="5" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="12" cy="19" r="2" />
        </>,
        props,
        'currentColor'
    )
}
