import type { RefObject } from 'react'
import type { SessionType } from './types'
import { useTranslation } from '@/lib/use-translation'

export function SessionTypeSelector(props: {
    sessionType: SessionType
    worktreeName: string
    worktreeInputRef: RefObject<HTMLInputElement | null>
    isDisabled: boolean
    onSessionTypeChange: (value: SessionType) => void
    onWorktreeNameChange: (value: string) => void
}) {
    const { t } = useTranslation()

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.type')}
            </label>
            <div className="flex flex-col gap-1.5">
                {(['simple', 'worktree'] as const).map((type) => (
                    <div key={type} className="flex flex-col gap-2">
                        {type === 'worktree' ? (
                            <div className="flex items-center gap-2">
                                <input
                                    id="session-type-worktree"
                                    type="radio"
                                    name="sessionType"
                                    value="worktree"
                                    checked={props.sessionType === 'worktree'}
                                    onChange={() => props.onSessionTypeChange('worktree')}
                                    disabled={props.isDisabled}
                                    className="accent-[var(--app-link)]"
                                />
                                <div className="flex-1">
                                    <div className="min-h-[34px] flex items-center">
                                        {props.sessionType === 'worktree' ? (
                                            <input
                                                ref={props.worktreeInputRef}
                                                type="text"
                                                placeholder={t('newSession.type.worktree.placeholder')}
                                                value={props.worktreeName}
                                                onChange={(e) => props.onWorktreeNameChange(e.target.value)}
                                                disabled={props.isDisabled}
                                                className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-60"
                                            />
                                        ) : (
                                            <>
                                                <label
                                                    htmlFor="session-type-worktree"
                                                    className="text-sm capitalize cursor-pointer"
                                                >
                                                    {t('newSession.type.worktree')}
                                                </label>
                                                <span className="ml-2 text-xs text-[var(--app-hint)]">
                                                    {t('newSession.type.worktree.desc')}
                                                </span>
                                            </>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <label className="flex items-center gap-2 cursor-pointer min-h-[34px]">
                                <input
                                    id="session-type-simple"
                                    type="radio"
                                    name="sessionType"
                                    value="simple"
                                    checked={props.sessionType === 'simple'}
                                    onChange={() => props.onSessionTypeChange('simple')}
                                    disabled={props.isDisabled}
                                    className="accent-[var(--app-link)]"
                                />
                                <span className="text-sm capitalize">{t('newSession.type.simple')}</span>
                                <span className="text-xs text-[var(--app-hint)]">
                                    {t('newSession.type.simple.desc')}
                                </span>
                            </label>
                        )}
                    </div>
                ))}
            </div>
        </div>
    )
}
