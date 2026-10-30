import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { BranchConversationRequest } from '@hapi/protocol/apiTypes'
import type { ApiClient } from '@/api/client'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { SelectControl } from '@/components/ui/select-control'
import { useTranslation } from '@/lib/use-translation'

export function BranchConversationDialog(props: {
    api: ApiClient
    machineId: string
    sourceAgent: string
    messageLocalId?: string
    onClose: () => void
    onSubmit: (options: BranchConversationRequest) => Promise<void>
}) {
    const { t } = useTranslation()
    const [agent, setAgent] = useState<'claude' | 'codex'>(props.sourceAgent === 'codex' ? 'codex' : 'claude')
    const [model, setModel] = useState('')
    const [boundary, setBoundary] = useState<'before' | 'after'>('before')
    const [workspace, setWorkspace] = useState<'current' | 'worktree'>('current')
    const [instruction, setInstruction] = useState('')
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    // Keep both payload and identity after an uncertain HTTP result. Edits mint a
    // new identity; submitting unchanged options recovers the same server child.
    const [attempt, setAttempt] = useState<{ fingerprint: string; requestId: string } | null>(null)
    const models = useQuery({
        queryKey: ['branch-models', props.machineId, agent],
        queryFn: async () => {
            if (agent === 'claude') {
                const result = await props.api.getMachineClaudeModels(props.machineId)
                if (!result.success) throw new Error(result.error ?? t('branch.modelsError'))
                return (result.availableModels ?? []).map(item => ({ value: item.value, label: item.displayName ?? item.value }))
            }
            const result = await props.api.getMachineCodexModels(props.machineId)
            if (!result.success) throw new Error(result.error ?? t('branch.modelsError'))
            return (result.models ?? []).map(item => ({ value: item.id, label: item.displayName }))
        },
        retry: false,
        staleTime: 30_000
    })
    const submit = async () => {
        const options = { agent, model: model || undefined, boundary, workspace,
            messageLocalId: props.messageLocalId, instruction: instruction.trim() }
        const fingerprint = JSON.stringify(options)
        const requestId = attempt?.fingerprint === fingerprint ? attempt.requestId : crypto.randomUUID()
        setAttempt({ fingerprint, requestId })
        setPending(true)
        setError(null)
        try { await props.onSubmit({ ...options, requestId }) }
        catch (err) { setError(err instanceof Error ? err.message : String(err)) }
        finally { setPending(false) }
    }
    const control = 'w-full rounded border border-[var(--app-divider)] bg-[var(--app-bg)] p-2 text-sm'
    return <Dialog open onOpenChange={open => { if (!open && !pending) props.onClose() }}>
        <DialogContent closeButtonClassName={pending ? 'hidden' : undefined} className="max-w-lg max-h-[90dvh] overflow-y-auto">
            <DialogHeader>
                <DialogTitle>{t('branch.title')}</DialogTitle>
                <DialogDescription>{t('branch.description')}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
                {props.messageLocalId ? <label className="text-sm">{t('branch.boundary')}
                    <SelectControl aria-label={t('branch.boundary')} className={control} value={boundary} disabled={pending}
                        onChange={event => setBoundary(event.target.value as 'before' | 'after')}>
                        <option value="before">{t('branch.before')}</option>
                        <option value="after">{t('branch.after')}</option>
                    </SelectControl>
                </label> : <p className="text-sm">{t('branch.current')}</p>}
                <label className="text-sm">Harness
                    <SelectControl aria-label="Harness" className={control} value={agent} disabled={pending}
                        onChange={event => { setAgent(event.target.value as 'claude' | 'codex'); setModel('') }}>
                        <option value="claude">Claude Code</option><option value="codex">Codex</option>
                    </SelectControl>
                </label>
                <label className="text-sm">{t('newSession.model')}
                    <SelectControl aria-label={t('newSession.model')} className={control} value={model} disabled={pending || models.isFetching}
                        onChange={event => setModel(event.target.value)}>
                        <option value="">{t('branch.defaultModel')}</option>
                        {models.data?.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </SelectControl>
                </label>
                {models.error ? <p role="status" className="text-sm text-[var(--app-hint)]">{t('branch.modelsError')}</p> : null}
                <label className="text-sm">{t('branch.workspace')}
                    <SelectControl aria-label={t('branch.workspace')} className={control} value={workspace} disabled={pending}
                        onChange={event => setWorkspace(event.target.value as 'current' | 'worktree')}>
                        <option value="current">{t('branch.currentWorkspace')}</option>
                        <option value="worktree">{t('branch.worktree')}</option>
                    </SelectControl>
                </label>
                <p className="text-xs text-[var(--app-hint)]">{t('branch.filesNotice')}</p>
                <label className="text-sm">{t('branch.instruction')}
                    <textarea aria-label={t('branch.instruction')} className={control} rows={4} value={instruction} maxLength={16000}
                        disabled={pending} onChange={event => setInstruction(event.target.value)} />
                </label>
                {error ? <div role="alert" className="text-sm text-red-600">
                    <p>{error}</p><p>{t('branch.retryNotice')}</p>
                </div> : null}
                <div className="flex justify-end gap-2">
                    <Button variant="secondary" disabled={pending} onClick={props.onClose}>{t('button.cancel')}</Button>
                    <Button disabled={pending || !instruction.trim()} onClick={() => void submit()}>
                        {t(pending ? 'message.fork.confirming' : 'branch.create')}
                    </Button>
                </div>
            </div>
        </DialogContent>
    </Dialog>
}
