import { useMemo } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { parseMcpServers, type McpServerInfo } from '@/utils/mcpInfo'

function ServerCard({ server }: { server: McpServerInfo }) {
    return (
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
            <div className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                <span className="text-sm font-medium text-[var(--app-fg)]">
                    {server.displayName}
                </span>
                <span className="text-xs text-[var(--app-hint)]">
                    {server.tools.length} {server.tools.length === 1 ? 'tool' : 'tools'}
                </span>
            </div>
            {server.tools.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                    {server.tools.map(tool => (
                        <span
                            key={tool}
                            className="rounded-md bg-[var(--app-subtle-bg)] px-2 py-0.5 text-xs font-mono text-[var(--app-hint)]"
                        >
                            {tool}
                        </span>
                    ))}
                </div>
            )}
        </div>
    )
}

export function McpInfoDialog(props: {
    open: boolean
    onOpenChange: (open: boolean) => void
    tools: string[] | undefined
}) {
    const servers = useMemo(() => parseMcpServers(props.tools), [props.tools])

    return (
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>MCP Servers</DialogTitle>
                    <DialogDescription>
                        {servers.length === 0
                            ? 'No MCP servers connected to this session.'
                            : `${servers.length} ${servers.length === 1 ? 'server' : 'servers'} connected with ${servers.reduce((sum, s) => sum + s.tools.length, 0)} tools total.`
                        }
                    </DialogDescription>
                </DialogHeader>

                {servers.length > 0 && (
                    <div className="mt-3 flex flex-col gap-2 max-h-[60vh] overflow-y-auto">
                        {servers.map(server => (
                            <ServerCard key={server.name} server={server} />
                        ))}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    )
}
