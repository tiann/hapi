import type { ReactNode } from 'react'

type IconProps = {
    className?: string
}

function createIcon(paths: ReactNode, props: IconProps) {
    return (
        <svg
            className={props.className ?? 'h-4 w-4'}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            {paths}
        </svg>
    )
}

export function TerminalIcon(props: IconProps) {
    return createIcon(
        <>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M7 9l3 3-3 3" />
            <path d="M11 15h6" />
        </>,
        props
    )
}

export function SearchIcon(props: IconProps) {
    return createIcon(
        <>
            <circle cx="11" cy="11" r="6" />
            <path d="M20 20l-3.5-3.5" />
        </>,
        props
    )
}

export function EyeIcon(props: IconProps) {
    return createIcon(
        <>
            <path d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z" />
            <circle cx="12" cy="12" r="2.5" />
        </>,
        props
    )
}

export function FileDiffIcon(props: IconProps) {
    return createIcon(
        <>
            <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" />
            <path d="M14 2v5h5" />
            <path d="M9 12h2" />
            <path d="M9 16h6" />
            <path d="M13 12h2" />
        </>,
        props
    )
}

export function GlobeIcon(props: IconProps) {
    return createIcon(
        <>
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18" />
            <path d="M12 3a12 12 0 0 1 0 18" />
            <path d="M12 3a12 12 0 0 0 0 18" />
        </>,
        props
    )
}

export function ClipboardIcon(props: IconProps) {
    return createIcon(
        <>
            <rect x="8" y="3" width="8" height="4" rx="1" />
            <path d="M9 7H7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2" />
        </>,
        props
    )
}

export function BulbIcon(props: IconProps) {
    return createIcon(
        <>
            <path d="M9 18h6" />
            <path d="M10 22h4" />
            <path d="M8 10a4 4 0 1 1 8 0c0 1.6-.8 2.4-1.7 3.4-.6.7-1.3 1.4-1.3 2.6h-2c0-1.2-.7-1.9-1.3-2.6C8.8 12.4 8 11.6 8 10z" />
        </>,
        props
    )
}

export function PuzzleIcon(props: IconProps) {
    return createIcon(
        <>
            <path d="M9 3a2 2 0 0 1 2 2v1h2V5a2 2 0 1 1 4 0v3h-3v2h1a2 2 0 1 1 0 4h-1v2h3v3H6a2 2 0 0 1-2-2v-3h3v-2H6a2 2 0 1 1 0-4h1V8H4V5a2 2 0 0 1 2-2h3z" />
        </>,
        props
    )
}

export function RocketIcon(props: IconProps) {
    return createIcon(
        <>
            <path d="M12 2c4 1 6 4 7 8-2 1-4 2-7 2s-5-1-7-2c1-4 3-7 7-8z" />
            <path d="M9 14l-2 6 5-3" />
            <path d="M15 14l2 6-5-3" />
            <circle cx="12" cy="8.5" r="1.2" />
        </>,
        props
    )
}

export function WrenchIcon(props: IconProps) {
    return createIcon(
        <>
            <path d="M21 7a5 5 0 0 1-7 4L7 18a2 2 0 0 1-3-3l7-7a5 5 0 0 1 6-6l-3 3 4 4 3-3z" />
        </>,
        props
    )
}

export function QuestionIcon(props: IconProps) {
    return createIcon(
        <>
            <circle cx="12" cy="12" r="9" />
            <path d="M9.5 9a2.5 2.5 0 1 1 4.1 1.9c-.9.7-1.6 1.3-1.6 2.6" />
            <path d="M12 17h.01" />
        </>,
        props
    )
}
