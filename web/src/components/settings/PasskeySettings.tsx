import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PasskeySummary } from '@hapi/protocol'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { useAppContext } from '@/lib/app-context'
import { defaultPasskeyName, isPasskeyCancelled, isPasskeySupported, registerPasskey } from '@/lib/passkey'
import { queryKeys } from '@/lib/query-keys'
import { formatRelativeTime, formatSessionListDate } from '@/lib/relativeTime'
import { useTranslation } from '@/lib/use-translation'

function PasskeyRow(props: { passkey: PasskeySummary; onDelete: () => void; deleting: boolean }) {
    const { t } = useTranslation()
    const { passkey } = props
    const lastUsed = passkey.lastUsedAt ? formatRelativeTime(passkey.lastUsedAt, t) : null
    return (
        <li className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                    {passkey.name || t('settings.passkeys.unnamed')}
                </div>
                <div className="truncate text-xs text-[var(--app-hint)]">
                    {passkey.rpId}
                    {' · '}
                    {t('settings.passkeys.created', { date: formatSessionListDate(new Date(passkey.createdAt)) })}
                    {lastUsed ? ` · ${t('settings.passkeys.lastUsed', { time: lastUsed })}` : ''}
                </div>
                {!passkey.valid && (
                    <div className="text-xs text-red-500">{t('settings.passkeys.revoked')}</div>
                )}
            </div>
            <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={props.deleting}
                onClick={props.onDelete}
            >
                {t('settings.passkeys.remove')}
            </Button>
        </li>
    )
}

export function PasskeySettings() {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const queryClient = useQueryClient()
    const [error, setError] = useState<string | null>(null)
    const supported = isPasskeySupported()

    const { data, isLoading } = useQuery({
        queryKey: queryKeys.passkeys,
        queryFn: () => api.listPasskeys()
    })

    const add = useMutation({
        mutationFn: () => registerPasskey(api, defaultPasskeyName()),
        onMutate: () => setError(null),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.passkeys }),
        onError: (e) => {
            if (!isPasskeyCancelled(e)) setError(t('settings.passkeys.addFailed'))
        }
    })

    const remove = useMutation({
        mutationFn: (id: string) => api.deletePasskey(id),
        onMutate: () => setError(null),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.passkeys }),
        onError: () => setError(t('settings.passkeys.removeFailed'))
    })

    const passkeys = data?.passkeys ?? []

    return (
        <div className="space-y-3">
            <p className="text-sm text-[var(--app-hint)]">
                {supported ? t('settings.passkeys.description') : t('settings.passkeys.unsupported')}
            </p>
            {isLoading ? (
                <Spinner size="sm" />
            ) : passkeys.length > 0 ? (
                <ul className="divide-y divide-[var(--app-divider)]">
                    {passkeys.map((passkey) => (
                        <PasskeyRow
                            key={passkey.id}
                            passkey={passkey}
                            deleting={remove.isPending && remove.variables === passkey.id}
                            onDelete={() => {
                                if (window.confirm(t('settings.passkeys.removeConfirm'))) {
                                    remove.mutate(passkey.id)
                                }
                            }}
                        />
                    ))}
                </ul>
            ) : null}
            {error && <div className="text-sm text-red-500">{error}</div>}
            {supported && (
                <Button type="button" disabled={add.isPending} onClick={() => add.mutate()}>
                    {add.isPending && <Spinner size="sm" label={null} className="text-[var(--app-button-text)]" />}
                    {t('settings.passkeys.add')}
                </Button>
            )}
        </div>
    )
}
