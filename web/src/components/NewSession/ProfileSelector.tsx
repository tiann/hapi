import type { SessionProfile } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'

export function ProfileSelector(props: {
    agent: 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode'
    profileId: string | null
    profiles: SessionProfile[]
    isDisabled: boolean
    onProfileChange: (value: string | null) => void
}) {
    const { t } = useTranslation()

    if (props.agent !== 'codex') {
        return null
    }

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.profile')}
            </label>
            <select
                aria-label={t('newSession.profile')}
                value={props.profileId ?? ''}
                onChange={(e) => props.onProfileChange(e.target.value || null)}
                disabled={props.isDisabled}
                className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                <option value="">{t('newSession.profile.none')}</option>
                {props.profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                        {profile.label}
                    </option>
                ))}
            </select>
        </div>
    )
}
