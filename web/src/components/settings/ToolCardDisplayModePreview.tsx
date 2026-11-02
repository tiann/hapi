import type { ToolGroupBlock } from '@/chat/toolGroups'
import type { ToolCallBlock } from '@/chat/types'
import { HappyChatProvider, type HappyChatContextValue } from '@/components/AssistantChat/context'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { ToolGroupCard } from '@/components/ToolCard/ToolGroupCard'
import type { ToolCardDisplayMode } from '@/hooks/useToolCardDisplayMode'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'

const PREVIEW_STARTED_AT = new Date(2026, 7, 16, 4, 23, 50).getTime()
const PREVIEW_SESSION_ID = 'tool-card-display-preview'

function createCompletedToolBlock(args: {
    id: string
    name: string
    input: unknown
    result?: unknown
    startedAt: number
    completedAt: number
}): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: args.id,
        localId: null,
        createdAt: args.startedAt,
        invokedAt: null,
        tool: {
            id: args.id,
            name: args.name,
            state: 'completed',
            input: args.input,
            createdAt: args.startedAt,
            startedAt: args.startedAt,
            completedAt: args.completedAt,
            execStartedAt: args.startedAt,
            execCompletedAt: args.completedAt,
            description: null,
            result: args.result,
        },
        children: [],
    }
}

const GROUPED_EDIT_TOOLS = [
    createCompletedToolBlock({
        id: 'preview-edit-tool-card',
        name: 'CodexPatch',
        input: {
            changes: {
                'web/src/components/ToolCard/ToolCard.tsx': {
                    type: 'update',
                    unified_diff: '@@ -1,1 +1,1 @@',
                },
            },
        },
        result: 'Done!',
        startedAt: PREVIEW_STARTED_AT,
        completedAt: PREVIEW_STARTED_AT + 420,
    }),
    createCompletedToolBlock({
        id: 'preview-edit-tool-group-card',
        name: 'CodexPatch',
        input: {
            changes: {
                'web/src/components/ToolCard/ToolGroupCard.tsx': {
                    type: 'update',
                    unified_diff: '@@ -1,1 +1,1 @@',
                },
            },
        },
        result: 'Done!',
        startedAt: PREVIEW_STARTED_AT + 500,
        completedAt: PREVIEW_STARTED_AT + 1_100,
    }),
]

const GROUPED_EDIT_BLOCK: ToolGroupBlock = {
    kind: 'tool-group',
    id: 'preview-edit-group',
    createdAt: PREVIEW_STARTED_AT,
    invokedAt: null,
    firstToolId: GROUPED_EDIT_TOOLS[0].id,
    lastToolId: GROUPED_EDIT_TOOLS[1].id,
    tools: GROUPED_EDIT_TOOLS,
    defaultOpen: false,
    historyState: 'complete',
    needsOlderHistory: false,
    presentationMode: 'default',
    summary: {
        totalTools: 2,
        countsByKind: {
            read: 0,
            search: 0,
            command: 0,
            mutation: 2,
            web: 0,
            other: 0,
        },
        fileTargets: [],
        commandTargets: [],
        searchTargets: [],
        urlTargets: [],
        otherTargets: [],
        errorCount: 0,
        runningCount: 0,
        pendingCount: 0,
    },
}

const TERMINAL_COMMAND = 'bun run test:web -- toolGroups.test.ts'
const TERMINAL_BLOCK = createCompletedToolBlock({
    id: 'preview-terminal',
    name: 'CodexBash',
    input: { command: TERMINAL_COMMAND },
    result: {
        stdout: '12 tests passed\n',
        stderr: '',
        exit_code: 0,
    },
    startedAt: PREVIEW_STARTED_AT,
    completedAt: PREVIEW_STARTED_AT + 1_250,
})

const GIT_DIFF_BLOCK = createCompletedToolBlock({
    id: 'preview-git-diff',
    name: 'CodexBash',
    input: { command: 'git diff --stat' },
    result: {
        stdout: '2 files changed, 18 insertions(+), 4 deletions(-)\n',
        stderr: '',
        exit_code: 0,
    },
    startedAt: PREVIEW_STARTED_AT + 1_500,
    completedAt: PREVIEW_STARTED_AT + 2_100,
})

function createPreviewContext(mode: ToolCardDisplayMode, api: HappyChatContextValue['api']): HappyChatContextValue {
    return {
        api,
        sessionId: PREVIEW_SESSION_ID,
        metadata: null,
        terminalToolDisplayMode: mode === 'detailed' ? 'detailed' : 'compact',
        showSessionSummaryInChat: false,
        disabled: false,
        onRefresh: () => {},
        hasMoreMessages: false,
        isSyncingTail: false,
        isLoadingMoreMessages: false,
        loadOlderMessagesPreservingScroll: async () => 'terminal-stop',
    }
}

export function ToolCardDisplayModePreview(props: { mode: ToolCardDisplayMode }) {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const descriptionKey = `settings.chat.toolCardDisplay.preview.${props.mode}` as const
    const terminalToolDisplayMode = props.mode === 'detailed' ? 'detailed' : 'compact'

    return (
        <div className="mt-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-2.5" data-testid="tool-card-display-preview">
            <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-medium text-[var(--app-fg)]">{t('settings.chat.toolCardDisplay.preview')}</span>
                <span className="text-right text-[11px] leading-snug text-[var(--app-hint)]" aria-live="polite">{t(descriptionKey)}</span>
            </div>
            <div
                className="mt-2"
                data-testid="tool-card-display-preview-content"
                key={props.mode}
            >
                <HappyChatProvider value={createPreviewContext(props.mode, api)}>
                    {props.mode === 'grouped' ? (
                        <ToolGroupCard block={GROUPED_EDIT_BLOCK} metadata={null} />
                    ) : props.mode === 'compact' ? (
                        <div className="flex flex-col gap-2">
                            {[TERMINAL_BLOCK, GIT_DIFF_BLOCK].map((block) => (
                                <ToolCard
                                    key={block.id}
                                    api={api}
                                    sessionId={PREVIEW_SESSION_ID}
                                    metadata={null}
                                    terminalToolDisplayMode="compact"
                                    disabled={false}
                                    onDone={() => {}}
                                    block={block}
                                />
                            ))}
                        </div>
                    ) : (
                        <ToolCard
                            api={api}
                            sessionId={PREVIEW_SESSION_ID}
                            metadata={null}
                            terminalToolDisplayMode={terminalToolDisplayMode}
                            disabled={false}
                            onDone={() => {}}
                            block={TERMINAL_BLOCK}
                        />
                    )}
                </HappyChatProvider>
            </div>
        </div>
    )
}
