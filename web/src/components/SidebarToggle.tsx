function SidebarIcon(props: { direction: 'show'; className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 40"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            shapeRendering="geometricPrecision"
            className={props.className}
            aria-hidden="true"
        >
            <rect x="3" y="2" width="18" height="36" rx="3" fill="var(--app-bg)" />
            <path d="M9 12l6 8-6 8" />
        </svg>
    )
}

export function SidebarShowButton(props: {
    showLabel: string
    onShow: () => void
}) {
    return (
        <button
            type="button"
            className="sidebar-show-button hidden split:flex"
            aria-label={props.showLabel}
            title={props.showLabel}
            onClick={props.onShow}
        >
            <SidebarIcon direction="show" />
        </button>
    )
}
