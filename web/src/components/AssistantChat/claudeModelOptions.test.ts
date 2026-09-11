import { describe, expect, it } from 'vitest'
import { catalogReportsEffortLevels, findCatalogRowFor, getClaudeComposerModelOptions, getNextClaudeComposerModel, resolveClaudeComposerWireValue, resolveClaudeModelChangeEffortClear, resolveClaudeSupportedEffortLevels } from './claudeModelOptions'

const LIVE_CATALOG = [
    { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5[1m]', supportsFastMode: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'opus[1m]', displayName: 'Opus (1M context)', resolvedModel: 'claude-opus-5[1m]', supportsFastMode: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5', supportsFastMode: false, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-4-5-20251001', supportsFastMode: false }
]

// a catalog where `default` shares its resolvedModel
// with NO concrete row -- unlike LIVE_CATALOG above, where `default` and
// `opus[1m]` are siblings sharing "claude-opus-5[1m]". Real catalogs happen
// not to hit this today, but nothing in the protocol guarantees it.
const DEFAULT_ONLY_CATALOG = [
    { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-sonnet-5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'opus[1m]', displayName: 'Opus (1M context)', resolvedModel: 'claude-opus-5[1m]', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-4-5-20251001' }
]

// nothing in the control-protocol schema guarantees a
// `default` row is present.
const NO_DEFAULT_CATALOG = [
    { value: 'opus[1m]', displayName: 'Opus (1M context)', resolvedModel: 'claude-opus-5[1m]', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-4-5-20251001' }
]

// A claude CLI old enough to predate the supportedEffortLevels field:
// none of its rows carry it at all (as opposed to LIVE_CATALOG, where every
// row except haiku does -- confirming the CLI understands the field and
// haiku's absence is a real "unsupported" signal).
const NO_EFFORT_FIELD_CATALOG = [
    { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5[1m]' },
    { value: 'opus[1m]', displayName: 'Opus (1M context)', resolvedModel: 'claude-opus-5[1m]' },
    { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5' },
    { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-4-5-20251001' }
]

describe('getClaudeComposerModelOptions (fallback, no live catalog)', () => {
    it('includes the active non-preset Claude model in the options list', () => {
        expect(getClaudeComposerModelOptions('claude-opus-4-1-20250805')).toEqual([
            { value: null, label: 'Default' },
            { value: 'claude-opus-4-1-20250805', label: 'claude-opus-4-1-20250805' },
            { value: 'opus', label: 'Opus' },
            { value: 'fable', label: 'Fable' },
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'haiku', label: 'Haiku' },
        ])
    })

    it('does not duplicate preset Claude models', () => {
        expect(getClaudeComposerModelOptions('opus')).toEqual([
            { value: null, label: 'Default' },
            { value: 'opus', label: 'Opus' },
            { value: 'fable', label: 'Fable' },
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'haiku', label: 'Haiku' },
        ])
    })

    it('has no bare/[1m] duplicate pairs', () => {
        const options = getClaudeComposerModelOptions(null)
        for (const option of options) {
            expect(option.value?.endsWith('[1m]')).not.toBe(true)
        }
    })

    it('recognizes a legacy [1m] alias as the current model without duplicating it', () => {
        // sonnet[1m] is a role-B alias (still understood) but role A no
        // longer offers it as its own row -- it should surface as an
        // explicit extra option, not silently disappear.
        expect(getClaudeComposerModelOptions('sonnet[1m]')).toEqual([
            { value: null, label: 'Default' },
            { value: 'sonnet[1m]', label: 'Sonnet 1M' },
            { value: 'opus', label: 'Opus' },
            { value: 'fable', label: 'Fable' },
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'haiku', label: 'Haiku' },
        ])
    })
})

describe('getClaudeComposerModelOptions (live catalog)', () => {
    it('maps the live catalog rows, mapping the default row onto the null/Default option', () => {
        expect(getClaudeComposerModelOptions(null, LIVE_CATALOG)).toEqual([
            { value: null, label: 'Default (recommended)' },
            { value: 'opus[1m]', label: 'Opus (1M context)' },
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'haiku', label: 'Haiku' },
        ])
    })

    it('does not duplicate a current model already advertised by the catalog', () => {
        expect(getClaudeComposerModelOptions('sonnet', LIVE_CATALOG)).toEqual([
            { value: null, label: 'Default (recommended)' },
            { value: 'opus[1m]', label: 'Opus (1M context)' },
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'haiku', label: 'Haiku' },
        ])
    })

    it('matches a stored resolvedModel id against the catalog row instead of adding a duplicate', () => {
        // An existing session may have "claude-opus-5[1m]" stored (the
        // resolved SDK id) rather than the wire alias "opus[1m]" -- both
        // point at the same catalog row.
        expect(getClaudeComposerModelOptions('claude-opus-5[1m]', LIVE_CATALOG)).toEqual([
            { value: null, label: 'Default (recommended)' },
            { value: 'opus[1m]', label: 'Opus (1M context)' },
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'haiku', label: 'Haiku' },
        ])
    })

    it('adds an explicit row for a current model the catalog truly does not advertise', () => {
        expect(getClaudeComposerModelOptions('fable[1m]', LIVE_CATALOG)).toEqual([
            { value: null, label: 'Default (recommended)' },
            { value: 'opus[1m]', label: 'Opus (1M context)' },
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'haiku', label: 'Haiku' },
            { value: 'fable[1m]', label: 'Fable 1M' },
        ])
    })

    // when the current model's resolvedModel only
    // matches the `default` row (no sibling concrete row shares it, unlike
    // LIVE_CATALOG's opus[1m]/default pair), the picker must not silently
    // collapse the pin onto "Default" -- it must keep an explicit,
    // reselectable row for it.
    it('adds an explicit row for a resolvedModel that only the default row matches, instead of collapsing it onto Default', () => {
        expect(getClaudeComposerModelOptions('claude-sonnet-5', DEFAULT_ONLY_CATALOG)).toEqual([
            { value: null, label: 'Default (recommended)' },
            { value: 'opus[1m]', label: 'Opus (1M context)' },
            { value: 'haiku', label: 'Haiku' },
            { value: 'claude-sonnet-5', label: 'claude-sonnet-5' },
        ])
    })

    // nothing in the control-protocol schema
    // guarantees a `default` row is present. Without one, the picker would
    // have no way to unpin a model.
    it('synthesizes a Default/null row when the live catalog has no default row', () => {
        expect(getClaudeComposerModelOptions(null, NO_DEFAULT_CATALOG)).toEqual([
            { value: null, label: 'Default' },
            { value: 'opus[1m]', label: 'Opus (1M context)' },
            { value: 'haiku', label: 'Haiku' },
        ])
    })
})

describe('findCatalogRowFor', () => {
    it('matches an exact wire value first', () => {
        expect(findCatalogRowFor('sonnet', LIVE_CATALOG)?.value).toBe('sonnet')
    })

    it('matches a concrete (non-default) row by resolvedModel', () => {
        expect(findCatalogRowFor('claude-opus-5[1m]', LIVE_CATALOG)?.value).toBe('opus[1m]')
    })

    it('does not fall back to a default-only resolvedModel match for a concrete model', () => {
        expect(findCatalogRowFor('claude-sonnet-5', DEFAULT_ONLY_CATALOG)).toBeUndefined()
    })

    it('resolves null/auto/default to the default row', () => {
        expect(findCatalogRowFor(null, LIVE_CATALOG)?.value).toBe('default')
        expect(findCatalogRowFor('auto', LIVE_CATALOG)?.value).toBe('default')
        expect(findCatalogRowFor('default', LIVE_CATALOG)?.value).toBe('default')
    })

    it('returns undefined when there is no catalog', () => {
        expect(findCatalogRowFor('sonnet', undefined)).toBeUndefined()
        expect(findCatalogRowFor('sonnet', [])).toBeUndefined()
    })
})

describe('resolveClaudeComposerWireValue', () => {
    it('maps a stored resolved SDK id back onto the catalog row\'s own wire value', () => {
        // "claude-opus-5[1m]" is what get_context_usage/system-init report,
        // not the "opus[1m]" wire alias list_models actually offers as a
        // pickable value -- callers that need to match a catalog row's
        // `value` (picker selection display, Ctrl/Cmd+M cycling) need this
        // normalization or they silently find nothing.
        expect(resolveClaudeComposerWireValue('claude-opus-5[1m]', LIVE_CATALOG)).toBe('opus[1m]')
    })

    it('returns the value unchanged when it already matches a catalog row', () => {
        expect(resolveClaudeComposerWireValue('sonnet', LIVE_CATALOG)).toBe('sonnet')
    })

    it('returns the normalized value unchanged when the catalog has no matching row', () => {
        expect(resolveClaudeComposerWireValue('fable[1m]', LIVE_CATALOG)).toBe('fable[1m]')
    })

    // a resolvedModel that only the `default` row
    // matches must NOT collapse to null (which would demote a deliberate
    // concrete pin to "use the account default" and leave no row in
    // getClaudeComposerModelOptions() to reselect it from).
    it('returns the normalized value unchanged (does not collapse to null/Default) when only the default row shares its resolvedModel', () => {
        expect(resolveClaudeComposerWireValue('claude-sonnet-5', DEFAULT_ONLY_CATALOG)).toBe('claude-sonnet-5')
    })

    it('returns the normalized value unchanged when there is no live catalog', () => {
        expect(resolveClaudeComposerWireValue('claude-opus-5[1m]')).toBe('claude-opus-5[1m]')
        expect(resolveClaudeComposerWireValue('claude-opus-5[1m]', [])).toBe('claude-opus-5[1m]')
    })

    it('normalizes auto/default/empty to null, matching getClaudeComposerModelOptions', () => {
        expect(resolveClaudeComposerWireValue('auto', LIVE_CATALOG)).toBeNull()
        expect(resolveClaudeComposerWireValue('default', LIVE_CATALOG)).toBeNull()
        expect(resolveClaudeComposerWireValue(null, LIVE_CATALOG)).toBeNull()
        expect(resolveClaudeComposerWireValue(undefined, LIVE_CATALOG)).toBeNull()
    })

    it('the resolved value is always present as an option.value in the matching getClaudeComposerModelOptions() output (selection display contract)', () => {
        for (const currentModel of ['claude-opus-5[1m]', 'sonnet', 'fable[1m]', null, 'auto']) {
            const resolved = resolveClaudeComposerWireValue(currentModel, LIVE_CATALOG)
            const options = getClaudeComposerModelOptions(currentModel, LIVE_CATALOG)
            expect(options.some((option) => option.value === resolved)).toBe(true)
        }
    })
})

describe('getNextClaudeComposerModel', () => {
    // Static-fallback-only: no live-catalog parameter. modelOptions.ts's
    // getNextModelForFlavor cycles a supplied catalog inline instead (it only
    // ever has the flattened ModelOption[] shape, not the rich
    // ClaudeModelSummary[] this function's fallback path needs).
    it('cycles from a non-preset Claude model to the next selectable model instead of auto', () => {
        expect(getNextClaudeComposerModel('claude-opus-4-1-20250805')).toBe('opus')
    })
})

describe('catalogReportsEffortLevels', () => {
    it('is true when at least one row carries supportedEffortLevels, even if others (haiku) do not', () => {
        expect(catalogReportsEffortLevels(LIVE_CATALOG)).toBe(true)
    })

    it('is false when no row in the catalog carries supportedEffortLevels at all (older claude CLI)', () => {
        expect(catalogReportsEffortLevels(NO_EFFORT_FIELD_CATALOG)).toBe(false)
    })

    it('is false for an empty catalog', () => {
        expect(catalogReportsEffortLevels([])).toBe(false)
    })
})

describe('findCatalogRowFor family matching', () => {
    // The shape the CLI actually returns today: Fable only as a full SDK id,
    // Opus only with the [1m] suffix, neither equal to the stored preset.
    const CURRENT_CATALOG = [
        { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5[1m]' },
        { value: 'opus[1m]', displayName: 'Opus (1M context)', resolvedModel: 'claude-opus-5[1m]' },
        { value: 'claude-fable-5-1[1m]', displayName: 'Fable', resolvedModel: 'claude-fable-5-1' },
        { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5' },
        { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-4-5-20251001' }
    ]

    it('matches a stored preset to the row the catalog publishes for that family', () => {
        expect(findCatalogRowFor('fable', CURRENT_CATALOG)?.value).toBe('claude-fable-5-1[1m]')
        expect(findCatalogRowFor('opus', CURRENT_CATALOG)?.value).toBe('opus[1m]')
        expect(findCatalogRowFor('sonnet', CURRENT_CATALOG)?.value).toBe('sonnet')
    })

    it('never collapses a resolved SDK id onto another generation of its family', () => {
        // `fable` is an alias meaning "whatever Fable is now"; a resolved id is
        // a pin to one model. Collapsing the pin would show Sonnet 5 checked
        // for a session running Sonnet 4.5, with no row left to return to.
        expect(findCatalogRowFor('claude-sonnet-4-5-20250929', CURRENT_CATALOG)).toBeUndefined()
        expect(findCatalogRowFor('claude-opus-4-1-20250805', CURRENT_CATALOG)).toBeUndefined()
        // An exact resolvedModel match is still a match -- that row IS the pin.
        expect(findCatalogRowFor('claude-fable-5-1', CURRENT_CATALOG)?.value)
            .toBe('claude-fable-5-1[1m]')
    })

    it('takes any row of the family for a preset alias, both forms being one model', () => {
        const bothForms = [
            { value: 'claude-fable-5-1', displayName: 'Fable', resolvedModel: 'claude-fable-5-1' },
            { value: 'claude-fable-5-1[1m]', displayName: 'Fable 1M', resolvedModel: 'claude-fable-5-1' }
        ]
        expect(findCatalogRowFor('fable', bothForms)?.value).toBe('claude-fable-5-1')
        expect(findCatalogRowFor('fable[1m]', bothForms)?.value).toBe('claude-fable-5-1')
    })

    it('still finds nothing for a family the catalog does not carry', () => {
        expect(findCatalogRowFor('opusplan', CURRENT_CATALOG)).toBeUndefined()
        expect(findCatalogRowFor('some-other-vendor-model', CURRENT_CATALOG)).toBeUndefined()
    })
})

describe('resolveClaudeSupportedEffortLevels', () => {
    // The live-shaped scenario a hostile review round caught in production:
    // haiku itself carries no supportedEffortLevels, but sibling rows in the
    // same catalog do -- that's enough to confirm the CLI understands the
    // field, so haiku's absence is a real "zero levels" signal and the
    // composer/NewSession effort selector must gate to Auto-only for it.
    it('resolves haiku to an empty array (confirmed unsupported) when sibling rows in the same catalog report the field', () => {
        expect(resolveClaudeSupportedEffortLevels('haiku', LIVE_CATALOG)).toEqual([])
    })

    it('resolves a row with levels to those levels when the catalog confirms the field', () => {
        expect(resolveClaudeSupportedEffortLevels('sonnet', LIVE_CATALOG)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    })

    // When NO row in the catalog ever reports supportedEffortLevels (an
    // older claude CLI), every model -- not just haiku -- must be treated
    // as unconfirmed (undefined), not as confirmed-zero-support. undefined
    // is what tells callers (SessionChat.tsx, NewSession/index.tsx) to fall
    // back to the static effort list and leave a stored effort selection
    // alone instead of wiping it.
    it('answers from the measured static table when nothing in the catalog reports the field', () => {
        // Indistinguishable on the wire: an older CLI that never reports the
        // field, or an account whose only visible model happens to support no
        // effort. The static table is right either way -- it knows haiku
        // supports none and the other families support all five.
        expect(resolveClaudeSupportedEffortLevels('haiku', NO_EFFORT_FIELD_CATALOG)).toEqual([])
        expect(resolveClaudeSupportedEffortLevels('sonnet', NO_EFFORT_FIELD_CATALOG))
            .toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
        expect(resolveClaudeSupportedEffortLevels('opus[1m]', NO_EFFORT_FIELD_CATALOG))
            .toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    })

    it('resolves a Haiku-backed Default selection through the catalog before the static lookup', () => {
        // The `default` row's own value matches nothing in the static table, but
        // the concrete row sharing its resolvedModel names the family it points
        // at. Both surfaces pass a sentinel for Default -- 'auto' from New
        // Session, null from the composer.
        const haikuOnly = [
            { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-haiku-4-5-20251001' },
            { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-4-5-20251001' }
        ]
        expect(resolveClaudeSupportedEffortLevels('auto', haikuOnly)).toEqual([])
        expect(resolveClaudeSupportedEffortLevels(null, haikuOnly)).toEqual([])
        expect(resolveClaudeModelChangeEffortClear({
            currentEffort: 'high',
            nextModelValue: 'auto',
            availableModels: haikuOnly
        })).toBeNull()
    })

    it('resolves the Default sentinel through its concrete twin', () => {
        // This fixture's Default is backed by opus[1m], which the static table
        // knows supports every level.
        expect(resolveClaudeSupportedEffortLevels('default', NO_EFFORT_FIELD_CATALOG))
            .toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    })

    it('places a resolved SDK id on its family before the static lookup', () => {
        // A session created before discovery existed stores the resolved id, so
        // exact-matching the short aliases would call Haiku unknown and hand
        // back the full effort list.
        expect(resolveClaudeSupportedEffortLevels('claude-haiku-4-5-20251001', [])).toEqual([])
        expect(resolveClaudeSupportedEffortLevels('claude-sonnet-5', []))
            .toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
        expect(resolveClaudeSupportedEffortLevels('claude-opus-5[1m]', []))
            .toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    })

    it('stays undefined for a model neither the catalog nor the static table can place', () => {
        expect(resolveClaudeSupportedEffortLevels('opusplan', [
            { value: 'opusplan', displayName: 'Opus Plan', resolvedModel: 'claude-opusplan-1' }
        ])).toBeUndefined()
    })

    it('resolves undefined when the model value matches no row in the catalog', () => {
        expect(resolveClaudeSupportedEffortLevels('unrecognized-model-id', LIVE_CATALOG)).toBeUndefined()
    })

    // No live catalog at all (loading/probe failure/older CLI without
    // list_models) -- availableModels is empty, so there is no row to ask.
    // The static CLAUDE_MODEL_FALLBACK_OPTIONS list is itself hand-
    // maintained (shared/src/models.ts), so its capability is just as known
    // as its identity: haiku must gate to Auto-only here too, not silently
    // regress to the full static effort list just because the live catalog
    // hasn't loaded.
    describe('no live catalog (static fallback)', () => {
        it('resolves haiku to a confirmed-empty array from the static fallback list', () => {
            expect(resolveClaudeSupportedEffortLevels('haiku', [])).toEqual([])
        })

        it('resolves sonnet to the full effort level list from the static fallback list', () => {
            expect(resolveClaudeSupportedEffortLevels('sonnet', [])).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
        })

        it('normalizes a legacy [1m] alias to its bare family before matching the fallback list', () => {
            expect(resolveClaudeSupportedEffortLevels('sonnet[1m]', [])).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
        })

        it('places a resolved SDK id on its family instead of calling it unknown', () => {
            // This used to resolve undefined, which handed the full effort list
            // back for a stored `claude-haiku-...` id.
            expect(resolveClaudeSupportedEffortLevels('claude-opus-5[1m]', []))
                .toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
        })

        it('resolves undefined for an id whose family the list does not carry', () => {
            expect(resolveClaudeSupportedEffortLevels('claude-opusplan-1', [])).toBeUndefined()
            expect(resolveClaudeSupportedEffortLevels('some-other-vendor-model', [])).toBeUndefined()
        })

        it('resolves undefined when nothing is selected (auto/null)', () => {
            expect(resolveClaudeSupportedEffortLevels(null, [])).toBeUndefined()
            expect(resolveClaudeSupportedEffortLevels('auto', [])).toBeUndefined()
        })
    })
})

describe('resolveClaudeModelChangeEffortClear', () => {
    // The gap this closes: handleModelChange previously applied the new
    // model, then a separate reconciliation effect cleared an
    // incompatible effort in a SECOND request later. A prompt sent
    // between the two requests could reach the CLI with the old model's
    // effort attached to the new model, and a failed second request left
    // the stale effort in place. This resolves what to send in the SAME
    // request as the model change instead.
    it('returns null (clear it) when the target model does not support the currently pinned effort', () => {
        expect(resolveClaudeModelChangeEffortClear({
            currentEffort: 'high',
            nextModelValue: 'haiku',
            availableModels: LIVE_CATALOG
        })).toBeNull()
    })

    it('returns undefined (send nothing) when the target model supports the currently pinned effort', () => {
        expect(resolveClaudeModelChangeEffortClear({
            currentEffort: 'high',
            nextModelValue: 'sonnet',
            availableModels: LIVE_CATALOG
        })).toBeUndefined()
    })

    it('still clears for haiku when the catalog reports no effort field at all', () => {
        // The static table confirms haiku supports none, so the model change
        // carries the clear even though this catalog says nothing about effort.
        expect(resolveClaudeModelChangeEffortClear({
            currentEffort: 'high',
            nextModelValue: 'haiku',
            availableModels: NO_EFFORT_FIELD_CATALOG
        })).toBeNull()
    })

    it('returns undefined (send nothing) when the session has no effort pinned to begin with', () => {
        expect(resolveClaudeModelChangeEffortClear({
            currentEffort: null,
            nextModelValue: 'haiku',
            availableModels: LIVE_CATALOG
        })).toBeUndefined()
    })

    it('returns undefined (send nothing) when the target model row cannot be resolved from the catalog', () => {
        expect(resolveClaudeModelChangeEffortClear({
            currentEffort: 'high',
            nextModelValue: 'unrecognized-model-id',
            availableModels: LIVE_CATALOG
        })).toBeUndefined()
    })

    // The bug this whole signature change closes off: the fallback
    // (no-live-catalog) path used to be reachable only through an OPTIONAL
    // third parameter callers could forget -- and one call site
    // (SessionChat.tsx's handleModelChange) did, silently disabling the
    // atomic effort clear whenever no catalog was loaded. `nextModelValue`
    // is now the only way to identify the target model, so the fallback
    // lookup always has what it needs.
    it('returns null (clear it) in fallback mode -- no live catalog loaded -- when the target model does not support the currently pinned effort', () => {
        expect(resolveClaudeModelChangeEffortClear({
            currentEffort: 'high',
            nextModelValue: 'haiku',
            availableModels: []
        })).toBeNull()
    })
})
