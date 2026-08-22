import { CLAUDE_MODEL_FALLBACK_OPTIONS, getClaudeModelLabel } from '@hapi/protocol'
import type { ClaudeModelSummary } from '@hapi/protocol/apiTypes'

export type ClaudeComposerModelOption = {
    value: string | null
    label: string
}

function normalizeClaudeComposerModel(model?: string | null): string | null {
    const trimmedModel = model?.trim()
    if (!trimmedModel || trimmedModel === 'auto' || trimmedModel === 'default') {
        return null
    }

    return trimmedModel
}

/**
 * Resolve `model` -- a catalog wire value (e.g. `"opus[1m]"`), a resolved SDK
 * id (e.g. `"claude-opus-5[1m]"`), or the null/`'auto'`/`'default'` "no
 * explicit pin" sentinels -- to the single catalog row that represents it.
 * Every "which row is the current model?" call site (this file's two
 * functions below, plus NewSession/index.tsx and SessionChat.tsx) funnels
 * through this so they agree on one priority order instead of drifting into
 * slightly different `.find()`s:
 *
 *   1. An exact `value` match -- the row IS this wire value.
 *   2. A concrete (non-`default`) row's `resolvedModel` match -- a stored
 *      resolved SDK id was a deliberate pin to *that* model.
 *   3. The `default` row, but only when the caller has no explicit
 *      selection (`model` is null/`'auto'`/`'default'`).
 *
 * Deliberately never falls back to matching the `default` row purely by
 * `resolvedModel` for a concrete `model`: multiple rows commonly share a
 * `resolvedModel` with `default` (e.g. both "default" and "opus[1m]"
 * resolving to "claude-opus-5[1m]"), and collapsing a concrete pin into the
 * default row there would silently demote it -- the picker would show
 * "Default" checked for a model the user explicitly chose, with no row left
 * to reselect it from.
 */
export function findCatalogRowFor(
    model: string | null | undefined,
    availableModels: ClaudeModelSummary[] | undefined
): ClaudeModelSummary | undefined {
    if (!availableModels || availableModels.length === 0) return undefined
    if (!model || model === 'auto' || model === 'default') {
        return availableModels.find((entry) => entry.value === 'default')
    }
    return availableModels.find((entry) => entry.value === model)
        ?? availableModels.find((entry) => entry.value !== 'default' && entry.resolvedModel === model)
}

/**
 * Whether the running claude CLI's model catalog reports
 * `supportedEffortLevels` at all, versus a version that doesn't have the
 * field yet. A single row's *absence* of the field is ambiguous on its own
 * -- it could mean "this model doesn't support --effort" (the documented
 * contract, e.g. haiku) or "this CLI doesn't report the field for any
 * model" (an older CLI). The wire has no per-row way to tell those apart,
 * so that judgment has to happen at the catalog level: if *any* row in the same
 * response carries the field, this CLI reports it, and every other row's
 * absence is the real "unsupported" signal. If no row carries it, nothing
 * in this response confirms the field is understood, so no row's absence
 * can be trusted as a real signal either -- callers should treat the whole
 * catalog as unconfirmed and fall back to the static effort list rather
 * than asserting every model has zero support.
 */
export function catalogReportsEffortLevels(availableModels: ClaudeModelSummary[]): boolean {
    return availableModels.some((entry) => entry.supportedEffortLevels !== undefined)
}

// Strips a trailing "[1m]" suffix so a legacy alias or resolved SDK id
// (e.g. "sonnet[1m]") matches CLAUDE_MODEL_FALLBACK_OPTIONS' bare family
// keys ("sonnet"). Mirrors web/src/chat/modelConfig.ts's private
// stripClaude1mSuffix -- same operation, kept local here since that
// helper isn't exported and belongs to an unrelated concern (context-window
// budgeting, not effort capability).
function stripClaude1mSuffixForFallbackMatch(model: string): string {
    return model.endsWith('[1m]') ? model.slice(0, -'[1m]'.length) : model
}

// Looks up a model's effort capability in the static, hand-maintained
// CLAUDE_MODEL_FALLBACK_OPTIONS list (shared/src/models.ts) -- used when the
// live catalog can't confirm capability itself (no catalog at all, or a
// catalog present but with no row for this model). Unlike the live
// catalog's field, whose absence is ambiguous until another row confirms
// the CLI reports it, this list's `supportedEffortLevels` is never
// ambiguous: we wrote it, so a matching entry's value (including a
// confirmed-empty `[]` for haiku) is always a real answer. Returns
// `undefined` only when the model isn't in this list at all (unselected,
// or an id we don't recognize, e.g. a resolved SDK id) -- callers then fall
// back further to the fully static effort list.
function resolveClaudeFallbackSupportedEffortLevels(modelValue: string | null | undefined): string[] | undefined {
    if (!modelValue) {
        return undefined
    }
    const normalized = stripClaude1mSuffixForFallbackMatch(modelValue)
    return CLAUDE_MODEL_FALLBACK_OPTIONS.find((option) => option.value === normalized)?.supportedEffortLevels
}

/**
 * Resolve the effort levels `modelValue` supports.
 *
 * `modelValue` is the model's identifier (a catalog wire value, a resolved
 * SDK id, or the null/`'auto'`/`'default'` "no explicit pin" sentinels) --
 * this function derives which catalog row it refers to itself via
 * `findCatalogRowFor`, rather than trusting a caller to have already
 * resolved and passed the row. That closes off a real bug class: a
 * `selectedModel: ClaudeModelSummary | undefined` parameter is optional
 * information a call site can (and once did) forget to pass, silently
 * degrading to the fallback branch below even when a live catalog is
 * loaded. Requiring only the identifier -- which every caller always has --
 * makes "resolve capability with less information than is available"
 * impossible to express.
 *
 * Priority:
 *   1. A live catalog is loaded (`availableModels` is non-empty) and has
 *      confirmed `supportedEffortLevels` (some row carries the field, see
 *      catalogReportsEffortLevels above) -- if `modelValue` resolves to one
 *      of its rows, return that row's levels, possibly empty (e.g. haiku's
 *      real zero-support). If it resolves to no row, or the catalog hasn't
 *      confirmed the field at all, `undefined` -- stay unconfirmed rather
 *      than silently switching sources mid-catalog.
 *   2. No live catalog is loaded at all (`availableModels` is empty --
 *      probe failure, still loading, or an older CLI without list_models)
 *      -- look `modelValue` up in the static, hand-maintained
 *      CLAUDE_MODEL_FALLBACK_OPTIONS list instead. That list is ours, so
 *      its capability is exactly as known as its identity.
 *   3. Anything else (the model matches nothing in the fallback list
 *      either -- e.g. a legacy resolved SDK id) -- `undefined`, telling
 *      callers to fall back to the fully static effort list rather than
 *      asserting a capability we don't actually know.
 *
 * Centralizes this judgment in one place so every caller that gates or
 * reconciles an effort selection off it (SessionChat.tsx's composer wiring,
 * NewSession/index.tsx's launch form) agrees, instead of each re-deriving
 * the same checks inline.
 */
export function resolveClaudeSupportedEffortLevels(
    modelValue: string | null | undefined,
    availableModels: ClaudeModelSummary[]
): string[] | undefined {
    if (availableModels.length > 0) {
        if (!catalogReportsEffortLevels(availableModels)) return undefined
        const row = findCatalogRowFor(modelValue, availableModels)
        if (!row) return undefined
        return row.supportedEffortLevels ?? []
    }
    return resolveClaudeFallbackSupportedEffortLevels(modelValue)
}

/**
 * Whether a model change should carry an effort clear (`null`) in the SAME
 * request, so a switch to a model that doesn't support the currently
 * pinned effort can't leave the CLI holding an invalid model/effort pair
 * between two separate RPCs (SessionChat.tsx's handleModelChange).
 *
 * Returns:
 *   - `null` -- the target model is confirmed not to support the pinned
 *     effort; the caller should send `{ model, effort: null }` together.
 *   - `undefined` -- nothing to send: either there's no effort pinned, no
 *     resolvable target row, the catalog hasn't confirmed support either
 *     way (mirrors resolveClaudeSupportedEffortLevels' unconfirmed case),
 *     or the target model already supports the pinned effort. The
 *     existing reconciliation effect covers the "catalog resolves later"
 *     case separately.
 */
export function resolveClaudeModelChangeEffortClear(args: {
    currentEffort: string | null | undefined
    nextModelValue: string | null | undefined
    availableModels: ClaudeModelSummary[]
}): null | undefined {
    if (!args.currentEffort) {
        return undefined
    }
    const nextSupportedLevels = resolveClaudeSupportedEffortLevels(args.nextModelValue, args.availableModels)
    if (nextSupportedLevels === undefined) {
        return undefined
    }
    return nextSupportedLevels.includes(args.currentEffort) ? undefined : null
}

// The `default` row's wire value resolves to whatever the account's actual
// default model is server-side; HAPI's storage format keeps representing
// "use the default" as null (unchanged from before this catalog existed), so
// that row maps onto the existing null/"Default" option instead of adding a
// separate literal-string "default" option.
function buildDynamicClaudeComposerOptions(
    availableModels: ClaudeModelSummary[],
    normalizedCurrentModel: string | null
): ClaudeComposerModelOption[] {
    const options: ClaudeComposerModelOption[] = availableModels.map((entry) => ({
        value: entry.value === 'default' ? null : entry.value,
        label: entry.displayName
    }))

    // Guarantee an unpin/"Default" option exists even if the live catalog
    // omits a `default` row -- the control-protocol schema doesn't promise
    // one, and without it the picker would have no way to unpin a model, and
    // NewSession's initial 'auto' state would have no matching option
    //.
    if (!options.some((option) => option.value === null)) {
        options.unshift({ value: null, label: 'Default' })
    }

    if (
        normalizedCurrentModel
        && !findCatalogRowFor(normalizedCurrentModel, availableModels)
    ) {
        // The current model may be a legacy `[1m]` alias or a resolved SDK id
        // that the live catalog no longer advertises as its own row (bare
        // sonnet/opus/fable already carry the same window). findCatalogRowFor
        // already matched it against an advertised row's resolvedModel when
        // one truly represents it; only add an explicit extra row here when
        // it doesn't.
        options.push({
            value: normalizedCurrentModel,
            label: getClaudeModelLabel(normalizedCurrentModel) ?? normalizedCurrentModel
        })
    }

    return options
}

/**
 * Resolve `currentModel` to the wire value the live catalog actually lists as
 * its own row's `value`, so callers can drive picker selection/cycling off a
 * value that literally exists in getClaudeComposerModelOptions()'s output --
 * not a resolved SDK id (e.g. "claude-opus-5[1m]") the catalog only exposes
 * indirectly via a row's `resolvedModel` field.
 *
 * Without this, a session storing a resolved id has NO row in the options
 * list whose `value` equals it: the picker shows nothing checked, and
 * Ctrl/Cmd+M cycling (which falls back to the first/`null` "Default" option
 * on a "not found" index) silently clears the pinned model instead of
 * advancing to the next one. buildDynamicClaudeComposerOptions already does
 * the equivalent resolvedModel match when deciding whether to add an extra
 * row; this is the same normalization for consumers that need the *value*
 * itself (SessionChat.tsx's `model` prop to HappyComposer) rather than the
 * options array.
 *
 * Returns `currentModel` (normalized) unchanged when no live catalog is
 * available, or when the catalog truly has no row representing it -- both
 * cases already get an explicit row for the raw value from
 * getClaudeComposerModelOptions, so the raw value IS present in that list.
 */
export function resolveClaudeComposerWireValue(
    currentModel: string | null | undefined,
    availableModels?: ClaudeModelSummary[]
): string | null {
    const normalizedCurrentModel = normalizeClaudeComposerModel(currentModel)
    if (!normalizedCurrentModel || !availableModels || availableModels.length === 0) {
        return normalizedCurrentModel
    }

    const catalogValueOf = (entry: ClaudeModelSummary): string | null => entry.value === 'default' ? null : entry.value

    // findCatalogRowFor already implements this priority (exact value, then
    // a *concrete* non-`default` row's resolvedModel) and deliberately never
    // falls back to a `default`-only resolvedModel match: a stored concrete
    // id was a deliberate pin, not "use the account default", and multiple
    // rows commonly share a resolvedModel with `default` (e.g. both
    // "default" and "opus[1m]" resolving to "claude-opus-5[1m]"). Collapsing
    // that pin onto the `default` row here would return null and silently
    // demote it.
    const matched = findCatalogRowFor(normalizedCurrentModel, availableModels)
    return matched ? catalogValueOf(matched) : normalizedCurrentModel
}

/**
 * Build the Claude composer's model picker options. Prefers the live CLI
 * model catalog (`availableModels`, from `list_models`) when present; falls
 * back to `CLAUDE_MODEL_FALLBACK_OPTIONS` (no bare/`[1m]` duplicate pairs)
 * when the catalog hasn't loaded or the probe failed.
 */
export function getClaudeComposerModelOptions(
    currentModel?: string | null,
    availableModels?: ClaudeModelSummary[]
): ClaudeComposerModelOption[] {
    const normalizedCurrentModel = normalizeClaudeComposerModel(currentModel)

    if (availableModels && availableModels.length > 0) {
        return buildDynamicClaudeComposerOptions(availableModels, normalizedCurrentModel)
    }

    const options: ClaudeComposerModelOption[] = [
        { value: null, label: 'Default' }
    ]

    if (
        normalizedCurrentModel
        && !CLAUDE_MODEL_FALLBACK_OPTIONS.some((option) => option.value === normalizedCurrentModel)
    ) {
        options.push({
            value: normalizedCurrentModel,
            label: getClaudeModelLabel(normalizedCurrentModel) ?? normalizedCurrentModel
        })
    }

    // Project down to {value, label} -- CLAUDE_MODEL_FALLBACK_OPTIONS' rows
    // now also carry `supportedEffortLevels` (for resolveClaudeSupportedEffortLevels'
    // fallback lookup below), which isn't part of ClaudeComposerModelOption
    // and must not leak into the picker's option objects.
    options.push(...CLAUDE_MODEL_FALLBACK_OPTIONS.map((option) => ({ value: option.value, label: option.label })))

    return options
}

// Static-fallback-only cycler: no availableModels parameter. A live-catalog
// cycle has no valid production caller -- modelOptions.ts's generic layer only
// ever has the flattened ModelOption[] (customOptions), never the rich
// ClaudeModelSummary[] this function would need, so getModelOptionsForFlavor's
// claude branch cycles customOptions inline instead of calling into here.
export function getNextClaudeComposerModel(currentModel?: string | null): string | null {
    const normalizedCurrentModel = normalizeClaudeComposerModel(currentModel)
    const options = getClaudeComposerModelOptions(normalizedCurrentModel)
    const currentIndex = options.findIndex((option) => option.value === normalizedCurrentModel)

    if (currentIndex === -1) {
        // Same not-found contract as getNextModelForFlavor's claude branch: land
        // on the first concrete row rather than the null Default row, so an
        // unrecognized current model does not silently clear the pin.
        return options.find((option) => option.value !== null)?.value ?? null
    }

    return options[(currentIndex + 1) % options.length]?.value ?? null
}
