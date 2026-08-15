import { useMemo } from 'react'
import type { ApiClient } from '@/api/client'
import { useSendMessage } from '@/hooks/mutations/useSendMessage'
import { makeClientSideId } from '@/lib/messages'
import type { DecryptedMessage } from '@/types/api'
import type { DshAction, DshStateSnapshot } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'
import { useDshSessionState } from '@/lib/dshSessionState'
import { useDshAction } from '@/hooks/mutations/useDshAction'
import {
    DshGoalBar,
    DshJobsDock,
    DshModelPicker,
    DshPresetPicker,
    DshQueueDock,
    DshQuestionsDialog,
    DshSkillsPalette,
    DshSubagentsPanel
} from './DshSessionView/DshPanels'

type DshSessionPanelsProps = {
    api: ApiClient
    sessionId: string
    /** Raw hub messages; dsh_state payloads are folded here. */
    messages: DecryptedMessage[]
}

/**
 * DeepSeek Harness side panels embedded in the standard HAPI session view:
 * goal bar, queue dock, jobs dock, model picker, presets, skills and
 * subagents, plus the pending user-questions dialog. Conversation, composer,
 * permissions and tool cards use the standard HAPI UI — DSH only adds its
 * native panels on top.
 */
export function DshSessionPanels({ api, sessionId, messages }: DshSessionPanelsProps) {
    const { t } = useTranslation()
    const { snapshot } = useDshSessionState(messages)
    const dshAction = useDshAction(api, sessionId)
    const sendMessage = useSendMessage(api, sessionId)

    const dispatch = useMemo(() => {
        const run = (action: DshAction): Promise<unknown> => {
            return dshAction.mutateAsync(action).catch((error: unknown) => {
                console.error('[dsh] action failed', action.type, error)
                throw error
            })
        }
        return run
    }, [dshAction])

    const questions = snapshot.questions ?? null

    return (
        <div className="flex flex-col gap-2">
            {snapshot.goal?.objective ? <DshGoalBar snapshot={snapshot} dispatch={dispatch} /> : null}
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <DshModelPicker sessionId={sessionId} api={api} snapshot={snapshot} dispatch={dispatch} />
                <DshQueueDock snapshot={snapshot} dispatch={dispatch} />
                <DshJobsDock snapshot={snapshot} />
                <DshPresetPicker sessionId={sessionId} api={api} dispatch={dispatch} />
                <DshSkillsPalette
                    sessionId={sessionId}
                    api={api}
                    onInvoke={(name: string) => {
                        void sendMessage.sendMessage(`/${name}`, undefined, null, 'queue')
                    }}
                />
                <DshSubagentsPanel sessionId={sessionId} api={api} dispatch={dispatch} latestNativeSeq={0} />
            </div>
            {questions ? (
                <DshQuestionsDialog
                    questions={questions}
                    dispatch={dispatch}
                    onClose={() => {}}
                />
            ) : null}
            <div className="text-[10px] text-[var(--app-hint)]">{t('dsh.sessionLabel')}</div>
        </div>
    )
}
