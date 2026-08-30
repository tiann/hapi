import { useState, type ReactNode } from 'react'
import type { ContextDetails } from '@hapi/protocol'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogTrigger
} from '@/components/ui/dialog'
import { useTranslation } from '@/lib/use-translation'

function formatSlashCommand(value: string): string {
    return value.startsWith('/') ? value : `/${value}`
}

function SimpleList(props: { items: readonly string[] }) {
    return (
        <div className="grid gap-x-6 gap-y-1 pl-1 text-sm text-[var(--app-fg)] sm:grid-cols-2">
            {props.items.map((item, index) => (
                <div key={`${item}:${index}`} className="break-words">{item}</div>
            ))}
        </div>
    )
}

function Section(props: { title: string; count?: number; children: ReactNode }) {
    return (
        <section className="space-y-2">
            <div className="flex items-center gap-2 px-1">
                <h3 className="text-sm font-semibold text-[var(--app-fg)]">{props.title}</h3>
                {props.count !== undefined ? (
                    <span className="rounded-full border border-[var(--app-border)] px-1.5 py-0.5 text-[10px] leading-none text-[var(--app-hint)]">
                        {props.count}
                    </span>
                ) : null}
            </div>
            <div className="rounded-lg border border-[var(--app-border)] px-3 py-2">
                {props.children}
            </div>
        </section>
    )
}

function ClaudeDetails(props: { details: ContextDetails }) {
    const { t } = useTranslation()
    const claude = props.details.claude
    if (!claude) return null
    return (
        <>
            {claude.slashCommands?.length ? (
                <Section title={t('misc.contextSlashCommands')} count={claude.slashCommands.length}>
                    <SimpleList items={claude.slashCommands.map(formatSlashCommand)} />
                </Section>
            ) : null}
            {claude.skills?.length ? (
                <Section title={t('misc.contextSkills')} count={claude.skills.length}>
                    <SimpleList items={claude.skills.map((skill) => skill.name)} />
                </Section>
            ) : null}
            {claude.mcpTools?.length ? (
                <Section title={t('misc.contextMcpTools')} count={claude.mcpTools.length}>
                    <ClaudeMcpTools tools={claude.mcpTools} />
                </Section>
            ) : null}
            {claude.systemTools?.length ? (
                <Section title={t('misc.contextSystemTools')} count={claude.systemTools.length}>
                    <SimpleList items={claude.systemTools} />
                </Section>
            ) : null}
        </>
    )
}

function ClaudeMcpTools(props: { tools: NonNullable<NonNullable<ContextDetails['claude']>['mcpTools']> }) {
    const groups = new Map<string, string[]>()
    for (const tool of props.tools) {
        const serverName = tool.serverName ?? ''
        const names = groups.get(serverName) ?? []
        names.push(tool.name)
        groups.set(serverName, names)
    }

    return (
        <div className="space-y-3">
            {Array.from(groups.entries()).map(([serverName, tools]) => (
                <div key={serverName || 'mcp'}>
                    {serverName ? <div className="break-words text-sm text-[var(--app-fg)]">{serverName}</div> : null}
                    <div className={serverName ? 'mt-1 grid gap-x-6 gap-y-0.5 pl-3 text-xs text-[var(--app-hint)] sm:grid-cols-2' : 'grid gap-x-6 gap-y-0.5 text-sm text-[var(--app-fg)] sm:grid-cols-2'}>
                        {tools.map((tool, index) => <div key={`${tool}:${index}`} className="break-words">{tool}</div>)}
                    </div>
                </div>
            ))}
        </div>
    )
}

function CodexDetails(props: { details: ContextDetails }) {
    const { t } = useTranslation()
    const codex = props.details.codex
    if (!codex) return null
    return (
        <>
            {codex.slashCommands?.length ? (
                <Section title={t('misc.contextSlashCommands')} count={codex.slashCommands.length}>
                    <SimpleList items={codex.slashCommands.map(formatSlashCommand)} />
                </Section>
            ) : null}
            {codex.skills?.length ? (
                <Section title={t('misc.contextSkills')} count={codex.skills.length}>
                    <SimpleList items={codex.skills.map((skill) => skill.name)} />
                </Section>
            ) : null}
            {codex.mcpServers?.length ? (
                <Section title={t('misc.contextMcpServers')} count={codex.mcpServers.length}>
                    <div className="space-y-3">
                        {codex.mcpServers.map((server) => (
                            <div key={server.name}>
                                <div className="flex min-w-0 items-baseline justify-between gap-3">
                                    <span className="min-w-0 break-words text-sm text-[var(--app-fg)]">{server.name}</span>
                                    {server.status ? <span className="shrink-0 text-xs text-[var(--app-hint)]">{server.status}</span> : null}
                                </div>
                                {server.toolNames?.length ? (
                                    <div className="mt-1 grid gap-x-6 gap-y-0.5 pl-3 text-xs text-[var(--app-hint)] sm:grid-cols-2">
                                        {server.toolNames.map((toolName) => <div key={toolName} className="break-words">{toolName}</div>)}
                                    </div>
                                ) : (
                                    <div className="mt-1 text-xs text-[var(--app-hint)]">{t('misc.contextMcpServer')}</div>
                                )}
                            </div>
                        ))}
                    </div>
                </Section>
            ) : null}
        </>
    )
}

function hasVisibleDetails(details: ContextDetails | null | undefined): boolean {
    if (!details) return false
    if (details.provider === 'claude') {
        return Boolean(
            details.claude?.systemTools?.length
            || details.claude?.slashCommands?.length
            || details.claude?.skills?.length
            || details.claude?.mcpTools?.length
        )
    }
    return Boolean(
        details.codex?.slashCommands?.length
        || details.codex?.skills?.length
        || details.codex?.mcpServers?.length
    )
}

export function ContextDetailsDialog(props: {
    details?: ContextDetails | null
    triggerClassName: string
    triggerContent: ReactNode
    triggerAriaLabel?: string
}) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const details = props.details

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <button
                    type="button"
                    aria-label={props.triggerAriaLabel ?? t('misc.contextDetails')}
                    className={props.triggerClassName}
                >
                    {props.triggerContent}
                </button>
            </DialogTrigger>
            <DialogContent
                aria-describedby={undefined}
                className="flex max-h-[min(44rem,calc(100vh-2rem))] flex-col overflow-hidden px-2 py-4 sm:max-w-3xl"
                closeButtonClassName="top-2 z-20"
            >
                <DialogHeader className="relative z-10 shrink-0 items-center bg-[var(--app-dialog-bg)] pb-4 pr-0 text-center sm:text-center">
                    <DialogTitle>{t('misc.contextAgentDetailsTitle')}</DialogTitle>
                </DialogHeader>

                <div className="agent-details-scroll-y min-h-0 flex-1 overflow-y-auto">
                    <div className="space-y-3">
                        {details?.provider === 'claude' ? <ClaudeDetails details={details} /> : null}
                        {details?.provider === 'codex' ? <CodexDetails details={details} /> : null}
                        {!hasVisibleDetails(details) ? (
                            <div className="text-xs text-[var(--app-hint)]">{t('misc.contextNoDetails')}</div>
                        ) : null}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
