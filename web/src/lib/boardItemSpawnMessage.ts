import type { BoardItem } from '@/types/api'

/**
 * Builds the message delivered to a session spawned from a Boards card
 * (hapi#235/#238) — an instruction *to the agent*, not a reproduction of the
 * issue/PR body. The agent has its own `gh` access and is expected to fetch
 * the real content itself (`gh issue view <url>`) as its first action,
 * rather than being handed a pre-pasted, potentially large or malformatted
 * copy of it.
 *
 * Delivered as a real incoming message (router.tsx's `handleSpawnFromBoardItem`
 * stashes it, `handleSuccess` posts it via `api.sendMessage` right after
 * creation — same mechanism `spawn_peer`/`hapi-ping-peer` use, not composer
 * seeding) so the agent starts working immediately instead of leaving an
 * unsent draft for the operator to send themselves (operator feedback,
 * 2026-10-13: "a pretty poor way to link and kick off a session... should be
 * more akin to how spawn_peer works").
 */
export function buildBoardItemSpawnMessage(item: BoardItem): string {
    const kind = item.isPullRequest ? 'pull request' : 'issue'
    if (item.url && item.number !== null) {
        const location = item.repo ? ` (#${item.number}, ${item.repo})` : ` (#${item.number})`
        return `You've been spawned from a Boards card — ${item.url}${location}. Investigate the ${kind} and prepare to discuss/implement with the operator.`
    }
    return `You've been spawned from a Boards card: "${item.title}". It has no linked issue or PR — check the board or ask the operator for context.`
}
