import { useTranslation } from '@/lib/use-translation'

export type SessionView = 'chat' | 'files' | 'terminal'

type ViewSelectorProps = {
    currentView: SessionView
    onViewChange: (view: SessionView) => void
}

const views: { value: SessionView; labelKey: string; icon: React.ReactNode }[] = [
    {
        value: 'chat',
        labelKey: 'view.chat',
        icon: (
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
        )
    },
    {
        value: 'files',
        labelKey: 'view.files',
        icon: (
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                <polyline points="14 2 14 8 20 8" />
            </svg>
        )
    },
    {
        value: 'terminal',
        labelKey: 'view.terminal',
        icon: (
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
        )
    }
]

export function ViewSelector(props: ViewSelectorProps) {
    const { t } = useTranslation()
    const { currentView, onViewChange } = props

    return (
        <div className="flex items-center gap-1 p-1 bg-[var(--app-secondary-bg)] rounded-lg">
            {views.map((view) => {
                const isActive = currentView === view.value
                return (
                    <button
                        key={view.value}
                        type="button"
                        onClick={() => onViewChange(view.value)}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                            isActive
                                ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm'
                                : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                        }`}
                        title={t(view.labelKey)}
                        aria-label={t(view.labelKey)}
                        aria-pressed={isActive}
                    >
                        {view.icon}
                        <span className="hidden sm:inline">{t(view.labelKey)}</span>
                    </button>
                )
            })}
        </div>
    )
}
