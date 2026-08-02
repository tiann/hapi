import type { ReactNode } from 'react'
import type { SessionListToolbarItemId } from '@/hooks/useSessionListToolbarLayout'

type IconProps = { className?: string }

function icon(paths: ReactNode, props: IconProps) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
            aria-hidden="true"
        >
            {paths}
        </svg>
    )
}

export function SearchIcon(props: IconProps) {
    return icon(<><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></>, props)
}

export function CalendarIcon(props: IconProps) {
    return icon(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18" /></>, props)
}

export function MachineFilterIcon(props: IconProps) {
    return icon(<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />, props)
}

export function CodexImportIcon(props: IconProps) {
    return icon(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>, props)
}

export function RefreshIcon(props: IconProps) {
    return icon(<><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" /><path d="M21 3v5h-5" /></>, props)
}

export function FolderOpenIcon(props: IconProps) {
    return icon(<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />, props)
}

export function SettingsIcon(props: IconProps) {
    return icon(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></>, props)
}

export function PlusIcon(props: IconProps) {
    return icon(<><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>, props)
}

export function SessionListToolbarItemIcon(props: { item: SessionListToolbarItemId; className?: string }) {
    switch (props.item) {
        case 'search': return <SearchIcon className={props.className} />
        case 'dateFilter': return <CalendarIcon className={props.className} />
        case 'machineFilter': return <MachineFilterIcon className={props.className} />
        case 'codexImport': return <CodexImportIcon className={props.className} />
        case 'refresh': return <RefreshIcon className={props.className} />
        case 'browse': return <FolderOpenIcon className={props.className} />
    }
}
