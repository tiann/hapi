import { useMemo } from 'react'
import type { ApiClient } from '@/api/client'
import { getTelegramWebApp } from '@/hooks/useTelegram'
import type { DecryptedMessage, Session } from '@/types/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { MessageBubble } from '@/components/MessageBubble'
import { PermissionPanel } from '@/components/PermissionPanel'

function getSessionTitle(session: Session): string {
    if (session.metadata?.name) {
        return session.metadata.name
    }
    if (session.metadata?.summary?.text) {
        return session.metadata.summary.text
    }
    if (session.metadata?.path) {
        const parts = session.metadata.path.split('/').filter(Boolean)
        return parts.length > 0 ? parts[parts.length - 1] : session.id.slice(0, 8)
    }
    return session.id.slice(0, 8)
}

export function SessionDetail(props: {
    api: ApiClient
    session: Session
    messages: DecryptedMessage[]
    messagesWarning: string | null
    hasMoreMessages: boolean
    isLoadingMessages: boolean
    isLoadingMoreMessages: boolean
    onBack: () => void
    onRefreshAll: () => void
    onRefreshSession: () => void
    onLoadMore: () => void
}) {
    const requests = useMemo(() => {
        const rec = props.session.agentState?.requests ?? null
        if (!rec) return []
        return Object.entries(rec).map(([requestId, request]) => ({ requestId, request }))
    }, [props.session])

    const isTelegram = getTelegramWebApp() !== null

    return (
        <div className="flex flex-col gap-3">
            {!isTelegram && (
                <>
                    <div className="flex items-center justify-between gap-2">
                        <Button variant="secondary" size="sm" onClick={props.onBack}>
                            Back
                        </Button>
                        <Button variant="secondary" size="sm" onClick={props.onRefreshAll} disabled={props.isLoadingMessages}>
                            Refresh
                        </Button>
                    </div>

                    <Card>
                        <CardHeader className="pb-2">
                            <CardTitle className="truncate">{getSessionTitle(props.session)}</CardTitle>
                            <CardDescription className="truncate">
                                {props.session.metadata?.path ?? props.session.id}
                            </CardDescription>
                        </CardHeader>
                    </Card>
                </>
            )}

            <Card>
                <CardHeader className="pb-2">
                    <CardTitle>Messages</CardTitle>
                    <CardDescription>Decrypted message history</CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                    {props.messagesWarning ? (
                        <div className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
                            {props.messagesWarning}
                        </div>
                    ) : null}
                    {props.hasMoreMessages ? (
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={props.onLoadMore}
                            disabled={props.isLoadingMoreMessages}
                        >
                            {props.isLoadingMoreMessages ? 'Loading…' : 'Load older'}
                        </Button>
                    ) : null}

                    {props.isLoadingMessages ? (
                        <div className="text-sm text-[var(--app-hint)]">Loading…</div>
                    ) : (
                        <div className="mt-2 flex flex-col gap-2">
                            {props.messages.map((m) => (
                                <MessageBubble key={m.id} message={m} />
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            {requests.length > 0 ? (
                <PermissionPanel
                    api={props.api}
                    sessionId={props.session.id}
                    requestId={requests[0].requestId}
                    request={requests[0].request}
                    disabled={!props.session.active}
                    onDone={props.onRefreshSession}
                />
            ) : null}
        </div>
    )
}
