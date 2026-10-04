/**
 * Per-turn session title updates for agent flavors.
 *
 * The stock steer tells agents to call change_title "sparingly", so session
 * titles drift stale on long, evolving conversations. When the operator opts
 * in (hub settings toggle or env), each flavor swaps its sparing title block
 * for a per-turn rewrite steer. The sparing text itself stays in each
 * flavor's systemPrompt module — wording differs per flavor and off-mode
 * prompts must stay byte-identical; this module only provides the shared
 * per-turn replacement and the toggle.
 *
 * Resolution order:
 * 1. Explicit `HAPI_AUTO_TITLE_PER_TURN` env (0|false|off|no → off; anything else → on)
 * 2. Hub preference applied via `applyHubAutoTitlePerTurn` (from session bootstrap)
 * 3. Default: off (sparingly steer, matches upstream behavior)
 *
 * Hub-side manual renames set `metadata.nameLocked`; the hub keeps the pinned
 * name over agent writes until per-turn mode is re-enabled (which clears every
 * lock). Nothing here needs to track that — this module only shapes prompts.
 */

let hubPreference: boolean | undefined

/** Apply the hub-resolved toggle from session create/get bootstrap. */
export function applyHubAutoTitlePerTurn(enabled: boolean): void {
    hubPreference = enabled
}

/** Test-only: clear hub preference between cases. */
export function resetAutoTitlePerTurnForTests(): void {
    hubPreference = undefined
}

export function isAutoTitlePerTurnEnabled(
    env: NodeJS.ProcessEnv = process.env
): boolean {
    const raw = env.HAPI_AUTO_TITLE_PER_TURN
    if (raw !== undefined && raw !== '') {
        const normalized = raw.trim().toLowerCase()
        return !(normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no')
    }
    return hubPreference === true
}

/**
 * Per-turn mode steer: agents rewrite the session title at the end of every
 * user turn, even when the focus has shifted only slightly. Single line —
 * flavors interpolate it where their sparing block sits.
 */
export function buildPerTurnTitleParagraph(changeTitleTool: string): string {
    return `Per-turn title updates are enabled for this hub: before finishing each user turn, call the tool "${changeTitleTool}" with a concise task title (eight words or fewer, in the conversation's language) that reflects the current focus of the conversation. Rewrite the title every turn, even when the focus has shifted only slightly, and do not skip turns. If a call fails, finish the turn normally without retrying more than once.`
}
