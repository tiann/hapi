import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type {
    GitFileChange,
    HostFileEntry,
    HostFilePreviewResponse,
    HostOperationRequest,
    HostOperationSnapshot,
    Machine,
    RepositorySnapshot
} from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'

type WorkspaceDialog = 'create-file' | 'create-directory' | 'copy' | 'move' | 'delete' | 'clone' | 'push' | 'set-remote' | 'create-branch' | 'switch-branch' | 'delete-branch' | 'delete-remote-branch'
type FileConflictPolicy = 'fail' | 'replace' | 'new-copy' | 'skip'
type CommitKind = 'feat' | 'fix' | 'docs' | 'refactor' | 'test' | 'chore'
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

function conventionalMessage(kind: CommitKind, scope: string, subject: string, body: string): string {
    const header = `${kind}${scope.trim() ? `(${scope.trim()})` : ''}: ${subject.trim()}`
    return body.trim() ? `${header}\n\n${body.trim()}` : header
}

function Icon(props: { children: ReactNode; className?: string }) {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>{props.children}</svg>
}

function FolderIcon(props: { className?: string }) { return <Icon {...props}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Icon> }
function FileIcon(props: { className?: string }) { return <Icon {...props}><path d="M6 2h8l4 4v16H6z" /><path d="M14 2v5h5" /></Icon> }
function GitIcon(props: { className?: string }) { return <Icon {...props}><circle cx="12" cy="18" r="2" /><circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><path d="M6 8v3a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8M12 13v3" /></Icon> }
function RefreshIcon(props: { className?: string }) { return <Icon {...props}><path d="M20 6v5h-5" /><path d="M4 18v-5h5" /><path d="M18.5 9a7 7 0 0 0-12-2L4 11M20 13l-2.5 4a7 7 0 0 1-12-2" /></Icon> }
function UploadIcon(props: { className?: string }) { return <Icon {...props}><path d="M12 3v12" /><path d="m7 8 5-5 5 5" /><path d="M5 14v5h14v-5" /></Icon> }

function getMachineTitle(machine: Machine): string {
    return machine.metadata?.displayName || machine.metadata?.host || machine.id.slice(0, 8)
}

function isWindowsStylePath(path: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\')
}

function normalizePath(path: string): string {
    const value = path.replace(/[\\/]+/g, '/')
    if (value === '/' || /^[A-Za-z]:\/$/.test(value)) return value
    if (/^[A-Za-z]:$/.test(value)) return `${value}/`
    return value.replace(/\/+$/, '')
}

function displayPath(path: string, sample: string): string {
    return isWindowsStylePath(sample) ? path.replace(/\//g, '\\') : path
}

function joinPath(base: string, name: string): string {
    const normalized = normalizePath(base)
    const joined = normalized === '/' || /^[A-Za-z]:\/$/.test(normalized) ? `${normalized}${name}` : `${normalized}/${name}`
    return displayPath(joined, base)
}

function parentPath(path: string): string {
    const normalized = normalizePath(path)
    if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return displayPath(normalized, path)
    const index = normalized.lastIndexOf('/')
    const parent = index <= 0 ? '/' : normalized.slice(0, index)
    return displayPath(/^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent, path)
}

function isPathWithin(candidate: string, root: string): boolean {
    const child = normalizePath(candidate).toLowerCase()
    const parent = normalizePath(root).toLowerCase()
    return child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
}

function breadcrumbs(path: string, root: string): Array<{ label: string; path: string }> {
    const normalizedRoot = normalizePath(root)
    const normalizedPath = normalizePath(path)
    const rootLabel = normalizedRoot === '/' ? '/' : /^[A-Za-z]:\/$/.test(normalizedRoot) ? normalizedRoot.slice(0, 2) : normalizedRoot.split('/').pop() || normalizedRoot
    const result = [{ label: rootLabel, path: displayPath(normalizedRoot, root) }]
    const relative = normalizedPath.slice(normalizedRoot.length).replace(/^\/+/, '')
    let current = normalizedRoot
    for (const part of relative.split('/').filter(Boolean)) {
        current = current === '/' || /^[A-Za-z]:\/$/.test(current) ? `${current}${part}` : `${current}/${part}`
        result.push({ label: part, path: displayPath(current, root) })
    }
    return result
}

function operationDone(status: HostOperationSnapshot['status']): boolean {
    return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}

function operationResultCount(result: HostOperationSnapshot['result'] | undefined, key: string): number {
    const value = result?.[key]
    return Array.isArray(value) ? value.length : 0
}

function changeStaged(change: GitFileChange): boolean {
    return change.indexStatus !== '.' && change.indexStatus !== '?'
}

function changeUnstaged(change: GitFileChange): boolean {
    return change.worktreeStatus !== '.' || change.indexStatus === '?'
}

async function fileToBase64(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    }
    return btoa(binary)
}

export function WorkspaceBrowser(props: {
    api: ApiClient
    machines: Machine[]
    machinesLoading: boolean
    onStartSession: (machineId: string, directory: string) => void
    initialMachineId?: string
}) {
    const { t } = useTranslation()
    const [machineId, setMachineId] = useState<string | null>(props.initialMachineId ?? null)
    const [selectedRoot, setSelectedRoot] = useState<string | null>(null)
    const [currentPath, setCurrentPath] = useState<string | null>(null)
    const [entries, setEntries] = useState<HostFileEntry[]>([])
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [includeHidden, setIncludeHidden] = useState(false)
    const [tab, setTab] = useState<'files' | 'git'>('files')
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [activeOperation, setActiveOperation] = useState<HostOperationSnapshot | null>(null)
    const [repository, setRepository] = useState<RepositorySnapshot | null>(null)
    const [gitLoading, setGitLoading] = useState(false)
    const [commitMessage, setCommitMessage] = useState('')
    const [commitTemplate, setCommitTemplate] = useState<'conventional' | 'custom'>('conventional')
    const [commitKind, setCommitKind] = useState<CommitKind>('feat')
    const [commitScope, setCommitScope] = useState('')
    const [commitBody, setCommitBody] = useState('')
    const [dialog, setDialog] = useState<WorkspaceDialog | null>(null)
    const [dialogValue, setDialogValue] = useState('')
    const [dialogSecondValue, setDialogSecondValue] = useState('')
    const [cloneDestinationEdited, setCloneDestinationEdited] = useState(false)
    const [fileConflict, setFileConflict] = useState<FileConflictPolicy>('fail')
    const [createDestination, setCreateDestination] = useState(false)
    const [destinationMode, setDestinationMode] = useState<'current' | 'custom' | string>('current')
    const [preview, setPreview] = useState<HostFilePreviewResponse | null>(null)
    const [previewContent, setPreviewContent] = useState('')
    const [previewSaving, setPreviewSaving] = useState(false)
    const [previewLoading, setPreviewLoading] = useState(false)
    const [downloadingPath, setDownloadingPath] = useState<string | null>(null)
    const [uploadingName, setUploadingName] = useState<string | null>(null)
    const uploadInputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (props.machines.length === 0) return setMachineId(null)
        if (machineId && props.machines.some((machine) => machine.id === machineId)) return
        const preferred = props.initialMachineId
            ? props.machines.find((machine) => machine.id === props.initialMachineId)
            : undefined
        setMachineId(preferred?.id ?? props.machines[0].id)
    }, [machineId, props.machines, props.initialMachineId])

    const machine = useMemo(() => machineId ? props.machines.find((candidate) => candidate.id === machineId) ?? null : null, [machineId, props.machines])
    const roots = machine?.metadata?.workspaceRoots ?? []

    const loadDirectory = useCallback(async (path: string) => {
        if (!machineId) return
        setIsLoading(true)
        setError(null)
        try {
            const result = await props.api.listHostDirectory(machineId, path, includeHidden)
            if (!result.success || !result.entries) throw new Error(result.error ?? 'Failed to list directory')
            setEntries(result.entries)
            setCurrentPath(result.path ?? path)
            setSelected(new Set())
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : 'Failed to list directory')
        } finally {
            setIsLoading(false)
        }
    }, [includeHidden, machineId, props.api])

    const loadGit = useCallback(async () => {
        if (!machineId || !currentPath) return
        setGitLoading(true)
        setError(null)
        try {
            const result = await props.api.inspectHostGit(machineId, currentPath)
            if (!result.success || !result.repository) throw new Error(result.error ?? 'No Git repository found')
            setRepository(result.repository)
        } catch (gitError) {
            setRepository(null)
            setError(gitError instanceof Error ? gitError.message : 'Failed to inspect Git repository')
        } finally {
            setGitLoading(false)
        }
    }, [currentPath, machineId, props.api])

    const openPreview = useCallback(async (path: string) => {
        if (!machineId) return
        setPreviewLoading(true)
        setError(null)
        try {
            const result = await props.api.readHostFilePreview(machineId, path)
            if (!result.success) throw new Error(result.error ?? 'Failed to preview file')
            setPreview(result)
            setPreviewContent(result.text ?? '')
        } catch (previewError) {
            setError(previewError instanceof Error ? previewError.message : 'Failed to preview file')
        } finally {
            setPreviewLoading(false)
        }
    }, [machineId, props.api])

    const savePreview = useCallback(async () => {
        if (!machineId || !preview?.path || preview.kind !== 'text') return
        setPreviewSaving(true)
        setError(null)
        try {
            const result = await props.api.writeHostFile(machineId, {
                path: preview.path,
                content: previewContent,
                expectedModified: preview.modified,
                expectedSize: preview.size
            })
            if (!result.success) throw new Error(result.error ?? 'Failed to save file')
            setPreview(result)
            setPreviewContent(result.text ?? '')
            setNotice(t('browse.fileSaved'))
            if (currentPath) await loadDirectory(currentPath)
        } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : 'Failed to save file')
        } finally {
            setPreviewSaving(false)
        }
    }, [currentPath, loadDirectory, machineId, preview, previewContent, props.api, t])

    const downloadPath = useCallback(async (path: string) => {
        if (!machineId) return
        setDownloadingPath(path)
        setError(null)
        let downloadId: string | null = null
        try {
            const prepared = await props.api.prepareHostDownload(machineId, path)
            if (!prepared.success || !prepared.download) throw new Error(prepared.error ?? 'Failed to prepare download')
            downloadId = prepared.download.id
            const chunks: ArrayBuffer[] = []
            let offset = 0
            let done = false
            while (!done) {
                const chunk = await props.api.readHostDownloadChunk(machineId, downloadId, offset)
                if (!chunk.success || chunk.nextOffset === undefined || chunk.done === undefined || chunk.base64 === undefined) {
                    throw new Error(chunk.error ?? 'Failed to read download')
                }
                const binary = atob(chunk.base64)
                const bytes = new Uint8Array(binary.length)
                for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
                chunks.push(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
                offset = chunk.nextOffset
                done = chunk.done
            }
            const url = URL.createObjectURL(new Blob(chunks, { type: prepared.download.mimeType }))
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = prepared.download.name
            document.body.appendChild(anchor)
            anchor.click()
            anchor.remove()
            URL.revokeObjectURL(url)
        } catch (downloadError) {
            setError(downloadError instanceof Error ? downloadError.message : 'Failed to download')
        } finally {
            if (downloadId) await props.api.releaseHostDownload(machineId, downloadId).catch(() => {})
            setDownloadingPath(null)
        }
    }, [machineId, props.api])

    const uploadFile = useCallback(async (file: File) => {
        if (!machineId || !currentPath) return
        if (file.size > MAX_UPLOAD_BYTES) {
            setError(t('browse.uploadTooLarge'))
            return
        }
        setUploadingName(file.name)
        setError(null)
        setNotice(null)
        try {
            const result = await props.api.uploadHostFile(machineId, {
                directory: currentPath,
                name: file.name,
                contentBase64: await fileToBase64(file),
                conflict: 'new-copy'
            })
            if (!result.success) throw new Error(result.error ?? 'Failed to upload file')
            setNotice(t('browse.fileUploaded'))
            await loadDirectory(currentPath)
        } catch (uploadError) {
            setError(uploadError instanceof Error ? uploadError.message : 'Failed to upload file')
        } finally {
            setUploadingName(null)
        }
    }, [currentPath, loadDirectory, machineId, props.api, t])

    const selectUpload = () => uploadInputRef.current?.click()

    const handleUploadInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ''
        if (file) void uploadFile(file)
    }

    useEffect(() => {
        const nextRoot = roots.includes(selectedRoot ?? '') ? selectedRoot : roots[0] ?? null
        setSelectedRoot(nextRoot)
        if (nextRoot && (!currentPath || !isPathWithin(currentPath, nextRoot))) void loadDirectory(nextRoot)
    }, [currentPath, loadDirectory, roots, selectedRoot])

    useEffect(() => {
        setCurrentPath(null)
        setEntries([])
        setRepository(null)
        setSelected(new Set())
    }, [machineId])

    useEffect(() => {
        if (currentPath) void loadDirectory(currentPath)
    // Reload when the hidden-file preference changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [includeHidden])

    useEffect(() => {
        if (tab === 'git') void loadGit()
    }, [loadGit, tab])

    useEffect(() => {
        if (repository) setCommitTemplate(repository.commitTemplate)
    }, [repository?.commitTemplate, repository?.repositoryRoot])

    const runOperation = useCallback(async (request: HostOperationRequest) => {
        if (!machineId || (activeOperation && !operationDone(activeOperation.status))) return
        setError(null)
        setNotice(null)
        try {
            const started = await props.api.startHostOperation(machineId, request)
            if (!started.success || !started.operation) throw new Error(started.error ?? 'Failed to start operation')
            let operation = started.operation
            setActiveOperation(operation)
            while (!operationDone(operation.status)) {
                await new Promise((resolve) => setTimeout(resolve, 500))
                const current = await props.api.getHostOperation(machineId, operation.id)
                if (!current.success || !current.operation) throw new Error(current.error ?? 'Operation status unavailable')
                operation = current.operation
                setActiveOperation(operation)
            }
            if (operation.status !== 'succeeded') throw new Error(operation.error ?? operation.message ?? 'Operation did not complete')
            if (operation.domain === 'file') {
                setNotice(t('browse.operation.result', {
                    completed: operationResultCount(operation.result, 'paths'),
                    replaced: operationResultCount(operation.result, 'replaced'),
                    skipped: operationResultCount(operation.result, 'skipped')
                }))
            } else {
                setNotice(t('browse.operation.completed'))
            }
            if (currentPath) await loadDirectory(currentPath)
            if (tab === 'git') await loadGit()
        } catch (operationError) {
            setError(operationError instanceof Error ? operationError.message : 'Operation failed')
        }
    }, [activeOperation, currentPath, loadDirectory, loadGit, machineId, props.api, t, tab])

    const selectedPaths = [...selected]
    const atRoot = Boolean(currentPath && selectedRoot && normalizePath(currentPath) === normalizePath(selectedRoot))
    const currentCrumbs = currentPath && selectedRoot ? breadcrumbs(currentPath, selectedRoot) : []
    const operationBusy = Boolean(activeOperation && !operationDone(activeOperation.status))
    const resolvedCommitMessage = commitTemplate === 'conventional'
        ? conventionalMessage(commitKind, commitScope, commitMessage, commitBody)
        : commitMessage.trim()

    const openDialog = (next: WorkspaceDialog, value = '', secondValue = '') => {
        setDialogValue(value)
        setDialogSecondValue(secondValue)
        setCloneDestinationEdited(false)
        setFileConflict('fail')
        setCreateDestination(false)
        setDestinationMode(next === 'copy' || next === 'move' ? 'current' : 'custom')
        setDialog(next)
    }

    const submitDialog = () => {
        if (!dialog || !currentPath || operationBusy) return
        const value = dialogValue.trim()
        const secondValue = dialogSecondValue.trim()
        switch (dialog) {
            case 'create-file':
            case 'create-directory':
                if (!value) return
                void runOperation({ domain: 'file', operation: { kind: dialog, path: joinPath(currentPath, value) } })
                break
            case 'copy':
            case 'move':
                if (!value || !selectedPaths.length) return
                void runOperation({ domain: 'file', operation: {
                    kind: dialog,
                    sources: selectedPaths,
                    destination: value,
                    conflict: fileConflict,
                    createDestination
                } })
                break
            case 'delete':
                if (!selectedPaths.length) return
                void runOperation({ domain: 'file', operation: { kind: 'delete', paths: selectedPaths } })
                break
            case 'clone':
                if (!value || !secondValue) return
                void runOperation({ domain: 'git', operation: { kind: 'clone', source: value, destination: joinPath(currentPath, secondValue) } })
                break
            case 'push':
                if (!repository) return
                void runOperation({ domain: 'git', operation: { kind: 'push', repository: repository.repositoryRoot, remote: 'origin', setUpstream: !repository.upstream } })
                break
            case 'set-remote':
                if (!repository || !value) return
                void runOperation({ domain: 'git', operation: { kind: 'set-remote', repository: repository.repositoryRoot, remote: 'origin', url: value } })
                break
            case 'create-branch':
                if (!repository || !value) return
                void runOperation({ domain: 'git', operation: { kind: 'create-branch', repository: repository.repositoryRoot, name: value, startPoint: secondValue || undefined, switchTo: true } })
                break
            case 'switch-branch':
                if (!repository || !value) return
                void runOperation({ domain: 'git', operation: { kind: 'switch-branch', repository: repository.repositoryRoot, name: value } })
                break
            case 'delete-branch':
                if (!repository || !value) return
                void runOperation({ domain: 'git', operation: { kind: 'delete-branch', repository: repository.repositoryRoot, name: value, force: false } })
                break
            case 'delete-remote-branch':
                if (!repository || !value) return
                void runOperation({ domain: 'git', operation: { kind: 'delete-remote-branch', repository: repository.repositoryRoot, remote: secondValue || 'origin', name: value } })
                break
        }
        setDialog(null)
    }

    const updateCloneSource = (source: string) => {
        setDialogValue(source)
        if (!cloneDestinationEdited) {
            const suggested = source.trim().replace(/\/$/, '').split(/[/:]/).pop()?.replace(/\.git$/, '') ?? ''
            setDialogSecondValue(suggested)
        }
    }

    const mutateGit = (operation: Extract<HostOperationRequest, { domain: 'git' }>['operation']) => {
        void runOperation({ domain: 'git', operation })
    }

    const dialogTitle = dialog ? t({
        'create-file': 'browse.newFile',
        'create-directory': 'browse.newFolder',
        copy: 'browse.copy',
        move: 'browse.move',
        delete: 'browse.delete',
        clone: 'browse.cloneRepository',
        push: 'browse.push',
        'set-remote': 'browse.changeRemote',
        'create-branch': 'browse.branchCreate',
        'switch-branch': 'browse.branchSwitch',
        'delete-branch': 'browse.branchDelete',
        'delete-remote-branch': 'browse.branchDeleteRemote'
    }[dialog]) : ''
    const dialogDescription = dialog === 'delete'
        ? t('browse.deleteConfirm', { n: selectedPaths.length })
        : dialog === 'push'
            ? t('browse.pushConfirm')
            : dialog === 'set-remote'
                ? t('browse.remoteDescription')
                : dialog === 'delete-remote-branch'
                    ? t('browse.branchDeleteRemoteConfirm', { branch: dialogValue, remote: dialogSecondValue || 'origin' })
                    : dialog === 'delete-branch'
                        ? t('browse.branchDeleteConfirm', { branch: dialogValue })
                        : t('browse.locationDescription', { path: currentPath ?? '' })

    if (props.machines.length === 0 && !props.machinesLoading) {
        return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--app-hint)]">{t('browse.noMachinesConnected')}</div>
    }

    if (machine && roots.length === 0) {
        return <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"><div className="font-medium">{t('browse.noRootTitle')}</div><div className="max-w-md text-sm text-[var(--app-hint)]">{t('browse.noRootHint')}</div><code className="rounded bg-[var(--app-subtle-bg)] px-3 py-1.5 text-xs">hapi runner start --workspace-root /path</code></div>
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="space-y-2 border-b border-[var(--app-divider)] px-3 py-2">
                <select value={machineId ?? ''} onChange={(event) => setMachineId(event.target.value || null)} className="w-full bg-transparent text-sm outline-none">
                    {props.machines.map((candidate) => <option key={candidate.id} value={candidate.id}>{getMachineTitle(candidate)}</option>)}
                </select>
                {roots.length > 1 ? <select value={selectedRoot ?? ''} onChange={(event) => { setSelectedRoot(event.target.value); setCurrentPath(null) }} className="w-full bg-transparent text-xs text-[var(--app-hint)] outline-none">{roots.map((root) => <option key={root} value={root}>{root}</option>)}</select> : null}
                <div className="flex items-center gap-1 overflow-x-auto text-xs">
                    <button type="button" disabled={atRoot} onClick={() => currentPath && void loadDirectory(parentPath(currentPath))} className="rounded px-1.5 py-1 disabled:opacity-30">←</button>
                    {currentCrumbs.map((crumb, index) => <span key={crumb.path} className="flex shrink-0 items-center gap-1">{index ? <span className="text-[var(--app-hint)]">/</span> : null}<button type="button" onClick={() => void loadDirectory(crumb.path)} className={index === currentCrumbs.length - 1 ? 'font-medium' : 'text-[var(--app-hint)]'}>{crumb.label}</button></span>)}
                    <button type="button" onClick={() => currentPath && void loadDirectory(currentPath)} className="ml-auto rounded p-1" title={t('browse.refresh')}><RefreshIcon className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} /></button>
                </div>
                <div className="grid grid-cols-2 rounded-lg bg-[var(--app-subtle-bg)] p-1 text-sm">
                    <button type="button" onClick={() => setTab('files')} className={`rounded-md py-1.5 ${tab === 'files' ? 'bg-[var(--app-bg)] font-medium shadow-sm' : 'text-[var(--app-hint)]'}`}>{t('browse.files')}</button>
                    <button type="button" onClick={() => setTab('git')} className={`rounded-md py-1.5 ${tab === 'git' ? 'bg-[var(--app-bg)] font-medium shadow-sm' : 'text-[var(--app-hint)]'}`}>{t('browse.git')}</button>
                </div>
            </div>

            {error ? <div className="border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</div> : null}
            {notice ? <div className="border-b border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">{notice}</div> : null}
            {activeOperation && !operationDone(activeOperation.status) ? <div className="border-b border-[var(--app-divider)] px-3 py-2 text-xs text-[var(--app-hint)]"><div className="mb-1 flex items-center justify-between gap-2"><span className="min-w-0 flex-1 truncate">{activeOperation.message || activeOperation.kind}</span><span>{Math.round(activeOperation.progress * 100)}%</span><button type="button" onClick={() => machineId && void props.api.cancelHostOperation(machineId, activeOperation.id)} className="text-red-600">{t('common.cancel')}</button></div><div className="h-1 overflow-hidden rounded bg-[var(--app-subtle-bg)]"><div className="h-full bg-[var(--app-link)] transition-all" style={{ width: `${activeOperation.progress * 100}%` }} /></div></div> : null}

            {tab === 'files' ? (
                <>
                    <div className="flex flex-wrap items-center gap-1 border-b border-[var(--app-divider)] px-2 py-2 text-xs">
                        <button type="button" disabled={operationBusy} onClick={() => openDialog('create-file')} className="rounded-md border border-[var(--app-border)] px-2 py-1.5 disabled:opacity-40">{t('browse.newFile')}</button>
                        <button type="button" disabled={operationBusy} onClick={() => openDialog('create-directory')} className="rounded-md border border-[var(--app-border)] px-2 py-1.5 disabled:opacity-40">{t('browse.newFolder')}</button>
                        <input ref={uploadInputRef} type="file" className="hidden" aria-label={t('browse.upload')} onChange={handleUploadInputChange} />
                        <button type="button" aria-label={uploadingName ? t('browse.uploading') : t('browse.upload')} title={uploadingName ? t('browse.uploading') : t('browse.upload')} disabled={!currentPath || operationBusy || uploadingName !== null} onClick={selectUpload} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--app-border)] disabled:opacity-40"><UploadIcon className={uploadingName ? 'h-4 w-4 animate-pulse' : 'h-4 w-4'} /></button>
                        <button type="button" onClick={() => openDialog('copy', currentPath ?? '')} disabled={!selected.size || operationBusy} className="rounded-md border border-[var(--app-border)] px-2 py-1.5 disabled:opacity-40">{t('browse.copy')}</button>
                        <button type="button" onClick={() => openDialog('move', currentPath ?? '')} disabled={!selected.size || operationBusy} className="rounded-md border border-[var(--app-border)] px-2 py-1.5 disabled:opacity-40">{t('browse.move')}</button>
                        <button type="button" onClick={() => selectedPaths[0] && void downloadPath(selectedPaths[0])} disabled={selected.size !== 1 || operationBusy || downloadingPath !== null} className="rounded-md border border-[var(--app-border)] px-2 py-1.5 disabled:opacity-40">{t('browse.download')}</button>
                        <button type="button" onClick={() => openDialog('delete')} disabled={!selected.size || operationBusy} className="rounded-md border border-red-500/30 px-2 py-1.5 text-red-600 disabled:opacity-40">{t('browse.delete')}</button>
                        <button type="button" disabled={operationBusy} onClick={() => openDialog('clone')} className="rounded-md border border-[var(--app-border)] px-2 py-1.5 disabled:opacity-40">{t('browse.clone')}</button>
                        <label className="ml-auto flex items-center gap-1.5 text-[var(--app-hint)]"><input type="checkbox" checked={includeHidden} onChange={(event) => setIncludeHidden(event.target.checked)} />{t('browse.hidden')}</label>
                    </div>
                    <div className="app-scroll-y min-h-0 flex-1 p-1">
                        {entries.map((entry) => (
                            <div key={entry.path} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-[var(--app-subtle-bg)]">
                                <input type="checkbox" checked={selected.has(entry.path)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(entry.path); else next.delete(entry.path); return next })} aria-label={`Select ${entry.name}`} />
                                <button type="button" onClick={() => entry.type === 'directory' ? void loadDirectory(entry.path) : void openPreview(entry.path)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                                    {entry.type === 'directory' ? entry.isGitRepo ? <GitIcon className="h-5 w-5 shrink-0 text-[var(--app-link)]" /> : <FolderIcon className="h-5 w-5 shrink-0 text-[var(--app-link)]" /> : <FileIcon className="h-5 w-5 shrink-0 text-[var(--app-hint)]" />}
                                    <span className="min-w-0 flex-1"><span className="block truncate text-sm">{entry.name}</span><span className="block text-[10px] text-[var(--app-hint)]">{entry.type}{entry.size !== undefined ? ` · ${entry.size.toLocaleString()} B` : ''}</span></span>
                                </button>
                                <button type="button" disabled={downloadingPath !== null} onClick={() => void downloadPath(entry.path)} className="shrink-0 rounded px-1.5 py-1 text-xs text-[var(--app-link)] disabled:opacity-40">{t('browse.download')}</button>
                            </div>
                        ))}
                        {!isLoading && entries.length === 0 ? <div className="py-8 text-center text-sm text-[var(--app-hint)]">{t('browse.emptyDirectory')}</div> : null}
                    </div>
                </>
            ) : (
                <div className="app-scroll-y min-h-0 flex-1">
                    {gitLoading ? <div className="py-8 text-center text-sm text-[var(--app-hint)]">{t('browse.gitLoading')}</div> : repository ? (
                        <div className="space-y-4 p-3">
                            <div className="rounded-xl border border-[var(--app-border)] p-3"><div className="font-medium">{repository.branch ?? t('browse.detachedHead')}</div><div className="mt-1 text-xs text-[var(--app-hint)]">{repository.repositoryRoot}{repository.upstream ? ` · ${repository.upstream}` : ''} · ↑{repository.ahead} ↓{repository.behind}</div><div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={operationBusy} onClick={() => mutateGit({ kind: 'fetch', repository: repository.repositoryRoot })} className="rounded border border-[var(--app-border)] px-2 py-1 text-xs disabled:opacity-40">{t('browse.fetch')}</button><button type="button" disabled={operationBusy || !repository.upstream} onClick={() => mutateGit({ kind: 'update-current', repository: repository.repositoryRoot })} className="rounded border border-[var(--app-border)] px-2 py-1 text-xs disabled:opacity-40">{t('browse.updateCurrent')}</button><button type="button" disabled={operationBusy} onClick={() => openDialog('create-branch')} className="rounded border border-[var(--app-border)] px-2 py-1 text-xs disabled:opacity-40">{t('browse.branchCreate')}</button></div></div>
                            <div className="overflow-hidden rounded-xl border border-[var(--app-border)]">
                                <div className="border-b border-[var(--app-divider)] px-3 py-2 text-xs font-medium text-[var(--app-hint)]">{t('browse.branches')}</div>
                                {repository.branches.filter((branch) => !branch.remote).map((branch) => <div key={branch.name} className="flex items-center gap-2 border-b border-[var(--app-divider)] px-3 py-2 last:border-0"><span className="min-w-0 flex-1 truncate text-sm">{branch.name}{branch.current ? ` · ${t('browse.current')}` : ''}{branch.upstream ? <span className="text-xs text-[var(--app-hint)]"> · {branch.upstream}</span> : null}</span>{!branch.current ? <button type="button" disabled={operationBusy} onClick={() => openDialog('switch-branch', branch.name)} className="text-xs text-[var(--app-link)] disabled:opacity-40">{t('browse.branchSwitch')}</button> : null}{!branch.current ? <button type="button" disabled={operationBusy} onClick={() => openDialog('delete-branch', branch.name)} className="text-xs text-red-600 disabled:opacity-40">{t('browse.delete')}</button> : null}</div>)}
                                {repository.branches.filter((branch) => branch.remote).map((branch) => <div key={`${branch.remote}/${branch.name}`} className="flex items-center gap-2 border-b border-[var(--app-divider)] px-3 py-2 last:border-0"><span className="min-w-0 flex-1 truncate text-sm text-[var(--app-hint)]">{branch.remote}/{branch.name}</span><button type="button" disabled={operationBusy} onClick={() => openDialog('delete-remote-branch', branch.name, branch.remote)} className="text-xs text-red-600 disabled:opacity-40">{t('browse.delete')}</button></div>)}
                            </div>
                            <div className="overflow-hidden rounded-xl border border-[var(--app-border)]">
                                {repository.changes.map((change) => <div key={`${change.path}:${change.indexStatus}:${change.worktreeStatus}`} className="flex items-center gap-2 border-b border-[var(--app-divider)] px-3 py-2 last:border-0"><span className="w-8 font-mono text-xs">{change.indexStatus}{change.worktreeStatus}</span><span className="min-w-0 flex-1 truncate text-sm">{change.path}</span>{changeUnstaged(change) ? <button type="button" disabled={operationBusy} onClick={() => mutateGit({ kind: 'stage', repository: repository.repositoryRoot, paths: [change.path] })} className="text-xs text-[var(--app-link)] disabled:opacity-40">{t('browse.stage')}</button> : null}{changeStaged(change) ? <button type="button" disabled={operationBusy} onClick={() => mutateGit({ kind: 'unstage', repository: repository.repositoryRoot, paths: [change.path] })} className="text-xs text-[var(--app-hint)] disabled:opacity-40">{t('browse.unstage')}</button> : null}</div>)}
                                {repository.changes.length === 0 ? <div className="px-3 py-5 text-center text-sm text-[var(--app-hint)]">{t('browse.gitClean')}</div> : null}
                            </div>
                            <div className="space-y-2"><select value={commitTemplate} onChange={(event) => { const template = event.target.value as typeof commitTemplate; setCommitTemplate(template); mutateGit({ kind: 'set-commit-template', repository: repository.repositoryRoot, template }) }} disabled={operationBusy} className="h-10 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-sm"><option value="conventional">{t('browse.commitConventional')}</option><option value="custom">{t('browse.commitCustom')}</option></select>{commitTemplate === 'conventional' ? <><div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)] gap-2"><select value={commitKind} onChange={(event) => setCommitKind(event.target.value as CommitKind)} className="h-10 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-sm">{(['feat', 'fix', 'docs', 'refactor', 'test', 'chore'] as CommitKind[]).map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select><input value={commitScope} onChange={(event) => setCommitScope(event.target.value)} placeholder={t('browse.commitScope')} className="h-10 min-w-0 rounded-lg border border-[var(--app-border)] bg-transparent px-3 text-sm" /></div><input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder={t('browse.commitSubject')} className="h-10 w-full rounded-lg border border-[var(--app-border)] bg-transparent px-3 text-sm" /><textarea value={commitBody} onChange={(event) => setCommitBody(event.target.value)} placeholder={t('browse.commitBody')} rows={2} className="w-full rounded-lg border border-[var(--app-border)] bg-transparent p-3 text-sm outline-none" /></> : <textarea value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder={t('browse.commitMessage')} rows={3} className="w-full rounded-xl border border-[var(--app-border)] bg-transparent p-3 text-sm outline-none" />}</div>
                            <div className="flex flex-wrap gap-2"><button type="button" disabled={operationBusy || !resolvedCommitMessage.trim() || !repository.changes.some(changeStaged)} onClick={() => { mutateGit({ kind: 'commit', repository: repository.repositoryRoot, message: resolvedCommitMessage, template: commitTemplate }); setCommitMessage(''); setCommitBody(''); setCommitScope('') }} className="rounded-lg bg-[var(--app-button)] px-4 py-2 text-sm text-[var(--app-button-text)] disabled:opacity-40">{t('browse.commit')}</button><button type="button" disabled={operationBusy} onClick={() => openDialog('push')} className="rounded-lg border border-[var(--app-border)] px-4 py-2 text-sm disabled:opacity-40">{t('browse.push')}</button><button type="button" disabled={operationBusy} onClick={() => openDialog('set-remote', repository.remotes.find((remote) => remote.name === 'origin')?.fetchUrl ?? '')} className="rounded-lg border border-[var(--app-border)] px-4 py-2 text-sm disabled:opacity-40">{t('browse.changeRemote')}</button></div>
                            <div className="text-xs text-[var(--app-hint)]">{repository.capabilities.ghAuthenticated ? t('browse.ghPreferred') : t('browse.gitFallback')}</div>
                        </div>
                    ) : <div className="flex flex-col items-center gap-3 py-10 text-sm text-[var(--app-hint)]"><GitIcon className="h-8 w-8" /><span>{t('browse.noRepository')}</span><button type="button" disabled={operationBusy} onClick={() => openDialog('clone')} className="rounded-lg border border-[var(--app-border)] px-3 py-2 text-[var(--app-fg)] disabled:opacity-40">{t('browse.cloneRepository')}</button></div>}
                </div>
            )}

            {currentPath ? <div className="flex items-center gap-2 border-t border-[var(--app-divider)] px-3 py-2"><div className="min-w-0 flex-1 truncate text-xs text-[var(--app-hint)]" title={currentPath}>{currentPath}</div><button type="button" onClick={() => machineId && props.onStartSession(machineId, currentPath)} className="rounded-lg bg-[var(--app-button)] px-4 py-1.5 text-sm font-medium text-[var(--app-button-text)]">{t('browse.startSession')}</button></div> : null}

            <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) setDialog(null) }}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>{dialogTitle}</DialogTitle>
                        <DialogDescription className="break-words">{dialogDescription}</DialogDescription>
                    </DialogHeader>
                    <form onSubmit={(event) => { event.preventDefault(); submitDialog() }} className="space-y-4">
                        {dialog === 'create-file' || dialog === 'create-directory' ? <label className="block space-y-1.5 text-sm"><span className="text-[var(--app-hint)]">{dialog === 'create-file' ? t('browse.fileName') : t('browse.folderName')}</span><input autoFocus required value={dialogValue} onChange={(event) => setDialogValue(event.target.value)} className="h-11 w-full rounded-lg border border-[var(--app-border)] bg-transparent px-3 outline-none focus:border-[var(--app-link)]" /></label> : null}
                        {dialog === 'copy' || dialog === 'move' ? <>
                            <label className="block space-y-1.5 text-sm"><span className="text-[var(--app-hint)]">{t('browse.destination')}</span><select value={destinationMode} onChange={(event) => { const next = event.target.value; setDestinationMode(next); if (next === 'current') setDialogValue(currentPath ?? ''); else if (next !== 'custom') setDialogValue(next) }} className="h-11 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 outline-none focus:border-[var(--app-link)]"><option value="current">{t('browse.destinationCurrent')}</option>{currentCrumbs.map((crumb) => <option key={crumb.path} value={crumb.path}>{crumb.label}: {crumb.path}</option>)}<option value="custom">{t('browse.destinationCustom')}</option></select></label>
                            {destinationMode === 'custom' ? <label className="block space-y-1.5 text-sm"><span className="text-[var(--app-hint)]">{t('browse.destinationCustom')}</span><input autoFocus required value={dialogValue} onChange={(event) => setDialogValue(event.target.value)} className="h-11 w-full rounded-lg border border-[var(--app-border)] bg-transparent px-3 outline-none focus:border-[var(--app-link)]" /></label> : null}
                            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={createDestination} onChange={(event) => setCreateDestination(event.target.checked)} />{t('browse.destinationCreate')}</label>
                            <label className="block space-y-1.5 text-sm"><span className="text-[var(--app-hint)]">{t('browse.conflict')}</span><select value={fileConflict} onChange={(event) => setFileConflict(event.target.value as FileConflictPolicy)} className="h-11 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 outline-none focus:border-[var(--app-link)]"><option value="fail">{t('browse.conflictFail')}</option><option value="replace">{t('browse.conflictReplace')}</option><option value="new-copy">{t('browse.conflictNewCopy')}</option><option value="skip">{t('browse.conflictSkip')}</option></select></label>
                        </> : null}
                        {dialog === 'clone' ? <><label className="block space-y-1.5 text-sm"><span className="text-[var(--app-hint)]">{t('browse.cloneSource')}</span><input autoFocus required value={dialogValue} onChange={(event) => updateCloneSource(event.target.value)} placeholder="owner/repository" className="h-11 w-full rounded-lg border border-[var(--app-border)] bg-transparent px-3 outline-none focus:border-[var(--app-link)]" /></label><label className="block space-y-1.5 text-sm"><span className="text-[var(--app-hint)]">{t('browse.destinationFolder')}</span><input required value={dialogSecondValue} onChange={(event) => { setCloneDestinationEdited(true); setDialogSecondValue(event.target.value) }} className="h-11 w-full rounded-lg border border-[var(--app-border)] bg-transparent px-3 outline-none focus:border-[var(--app-link)]" /></label></> : null}
                        {dialog === 'set-remote' ? <label className="block space-y-1.5 text-sm"><span className="text-[var(--app-hint)]">{t('browse.originUrl')}</span><input autoFocus required value={dialogValue} onChange={(event) => setDialogValue(event.target.value)} placeholder="https://github.com/owner/repository.git" className="h-11 w-full rounded-lg border border-[var(--app-border)] bg-transparent px-3 outline-none focus:border-[var(--app-link)]" /></label> : null}
                        {dialog === 'create-branch' ? <><label className="block space-y-1.5 text-sm"><span className="text-[var(--app-hint)]">{t('browse.branchName')}</span><input autoFocus required value={dialogValue} onChange={(event) => setDialogValue(event.target.value)} className="h-11 w-full rounded-lg border border-[var(--app-border)] bg-transparent px-3 outline-none focus:border-[var(--app-link)]" /></label><label className="block space-y-1.5 text-sm"><span className="text-[var(--app-hint)]">{t('browse.branchStartPoint')}</span><input value={dialogSecondValue} onChange={(event) => setDialogSecondValue(event.target.value)} placeholder={repository?.branch ?? ''} className="h-11 w-full rounded-lg border border-[var(--app-border)] bg-transparent px-3 outline-none focus:border-[var(--app-link)]" /></label></> : null}
                        {dialog === 'switch-branch' || dialog === 'delete-branch' ? <label className="block space-y-1.5 text-sm"><span className="text-[var(--app-hint)]">{t('browse.branchName')}</span><input autoFocus required value={dialogValue} onChange={(event) => setDialogValue(event.target.value)} className="h-11 w-full rounded-lg border border-[var(--app-border)] bg-transparent px-3 outline-none focus:border-[var(--app-link)]" /></label> : null}
                        {dialog === 'delete-remote-branch' ? <><label className="block space-y-1.5 text-sm"><span className="text-[var(--app-hint)]">{t('browse.branchName')}</span><input autoFocus required value={dialogValue} onChange={(event) => setDialogValue(event.target.value)} className="h-11 w-full rounded-lg border border-[var(--app-border)] bg-transparent px-3 outline-none focus:border-[var(--app-link)]" /></label><label className="block space-y-1.5 text-sm"><span className="text-[var(--app-hint)]">{t('browse.remote')}</span><input required value={dialogSecondValue} onChange={(event) => setDialogSecondValue(event.target.value)} className="h-11 w-full rounded-lg border border-[var(--app-border)] bg-transparent px-3 outline-none focus:border-[var(--app-link)]" /></label></> : null}
                        <div className="flex justify-end gap-2">
                            <button type="button" onClick={() => setDialog(null)} className="h-11 rounded-lg px-4 text-sm text-[var(--app-hint)]">{t('common.cancel')}</button>
                            <button type="submit" className={`h-11 rounded-lg px-4 text-sm font-medium ${dialog === 'delete' || dialog === 'delete-branch' || dialog === 'delete-remote-branch' ? 'bg-red-600 text-white' : 'bg-[var(--app-button)] text-[var(--app-button-text)]'}`}>{dialogTitle}</button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>

            <Dialog open={preview !== null || previewLoading} onOpenChange={(open) => { if (!open && !previewLoading) setPreview(null) }}>
                <DialogContent className="max-w-3xl">
                    <DialogHeader>
                        <DialogTitle>{preview?.name ?? t('browse.preview')}</DialogTitle>
                        <DialogDescription>{preview?.size !== undefined ? `${preview.size.toLocaleString()} B` : t('browse.preview')}</DialogDescription>
                    </DialogHeader>
                    {previewLoading ? <div className="py-8 text-center text-sm text-[var(--app-hint)]">{t('misc.loading')}</div> : null}
                    {preview?.kind === 'text' ? <>
                        <textarea value={previewContent} onChange={(event) => setPreviewContent(event.target.value)} className="min-h-80 w-full rounded-lg border border-[var(--app-border)] bg-transparent p-3 font-mono text-xs outline-none focus:border-[var(--app-link)]" spellCheck={false} />
                        <div className="flex justify-end gap-2"><button type="button" onClick={() => setPreview(null)} className="h-10 rounded-lg px-3 text-sm text-[var(--app-hint)]">{t('common.cancel')}</button><button type="button" disabled={previewSaving} onClick={() => void savePreview()} className="h-10 rounded-lg bg-[var(--app-button)] px-4 text-sm font-medium text-[var(--app-button-text)] disabled:opacity-40">{previewSaving ? t('loading') : t('common.save')}</button></div>
                    </> : null}
                    {preview?.kind === 'image' && preview.base64 ? <img src={`data:${preview.mimeType ?? 'image/*'};base64,${preview.base64}`} alt={preview.name ?? ''} className="max-h-[70vh] w-full object-contain" /> : null}
                    {preview?.kind === 'binary' ? <div className="py-8 text-center text-sm text-[var(--app-hint)]">{t('browse.previewUnavailable')}</div> : null}
                </DialogContent>
            </Dialog>
        </div>
    )
}
