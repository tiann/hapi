import { createHash } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import type { IssueFormCheckboxOption, IssueFormField, IssueTemplate } from '@hapi/protocol'

/** Hash of a template's raw file content — see IssueTemplateBase.revision. */
function hashTemplateRevision(raw: string): string {
    return createHash('sha256').update(raw).digest('hex')
}

const SUPPORTED_FIELD_TYPES = new Set(['markdown', 'input', 'textarea', 'dropdown', 'checkboxes'])

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined
}

function asStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// GitHub's issue-forms schema makes a field's own `id` optional (it exists
// only so GitHub can pre-fill the field from a URL query param) — `id` never
// reaches the rendered issue body (formatIssueBody keys sections by `label`,
// not `id`), so a field without one is still fully usable here, just needs a
// stable *internal* key for the answers map. Generated from the label
// (GitHub's own fallback source), slugified; a numeric suffix resolves any
// collision against both explicit and other generated ids in the same
// template (review finding: rejecting the whole template over a missing id
// makes an otherwise-valid, GitHub-accepted form unusable in Boards).
function slugify(label: string): string {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    return slug || 'field'
}

function generateFieldId(label: string, usedIds: Set<string>): string {
    const base = slugify(label)
    let candidate = base
    let suffix = 2
    while (usedIds.has(candidate)) {
        candidate = `${base}-${suffix}`
        suffix += 1
    }
    usedIds.add(candidate)
    return candidate
}

/**
 * Parses one `.github/ISSUE_TEMPLATE/*.yml` issue form into a normalized
 * `IssueTemplate`, or an `unsupported` marker when the form uses a
 * body-element `type` outside `markdown`/`input`/`textarea`/`dropdown`/
 * `checkboxes` (operator decision, hapi#238: the whole template is excluded
 * rather than rendered with that one field silently dropped — "partial
 * support that fails loudly beats full support that silently drops a
 * field").
 */
export function parseIssueFormYaml(id: string, raw: string): IssueTemplate {
    let doc: unknown
    try {
        doc = parseYaml(raw)
    } catch {
        return { id, name: id, kind: 'unsupported', reason: 'Could not parse this template\'s YAML', githubValid: false }
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        return { id, name: id, kind: 'unsupported', reason: 'Template is not a valid issue form', githubValid: false }
    }
    const obj = doc as Record<string, unknown>
    // GitHub requires `name` on an issue form — the legacy .md path
    // already enforces this via hasRequiredLegacyTemplateFrontmatter, but
    // this .yml path fell back to the filename instead of rejecting it,
    // so a file missing it was accepted as a usable form and counted
    // toward local .github-inheritance coverage even though GitHub's own
    // chooser would never have offered it (review finding, tiann/hapi#2147).
    const name = asString(obj.name)
    if (!name) {
        return { id, name: id, kind: 'unsupported', reason: 'Template is missing the required "name" field', githubValid: false }
    }
    // `description` is required alongside `name` per GitHub's own top-level
    // syntax table (review finding, tiann/hapi#2147, follow-up on the name
    // check above) — a form missing it isn't one GitHub's own template
    // editor would even save, let alone offer in the chooser.
    if (!asString(obj.description)) {
        return { id, name, kind: 'unsupported', reason: 'Template is missing the required "description" field', githubValid: false }
    }
    const bodyRaw = obj.body
    if (!Array.isArray(bodyRaw) || bodyRaw.length === 0) {
        return { id, name, kind: 'unsupported', reason: 'Template has no body elements', githubValid: false }
    }
    // GitHub explicitly documents this as a validation error ("Body must
    // contain at least one non-markdown field") — markdown elements are
    // static text, never submitted, so a body made of only markdown
    // collects no input at all (review finding, tiann/hapi#2147, follow-up).
    if (bodyRaw.every(element => (element as Record<string, unknown> | null)?.type === 'markdown')) {
        return { id, name, kind: 'unsupported', reason: 'Template body must contain at least one non-markdown field', githubValid: false }
    }

    // GitHub issue forms can also declare a top-level `type:` (issue type)
    // or `projects:` (project board auto-assignment) — neither survives
    // Boards' own create path (hub only ever submits title/body/labels/
    // assignees), so silently proceeding would create an issue missing
    // metadata the template author expected every submission to carry.
    // Same "fail loudly" principle as an unsupported body-element type
    // above: the whole template is excluded rather than rendered with
    // one of its declared properties silently dropped (review finding).
    //
    // Recorded rather than returned immediately (bot review,
    // tiann/hapi#2147, follow-up) — the rest of the body still needs full
    // validation below. An early return here (or on a field-level `upload`
    // type further down) skipped validating whatever came after it, so a
    // template with, say, a `projects:` key followed by a genuinely
    // malformed field used to come back `githubValid: true` on the
    // strength of the recognized-but-unsupported feature alone, never
    // reaching the field that actually makes it something GitHub's own
    // chooser would reject. That wrongly counts as local `.github`-
    // inheritance coverage, letting a viewer eligible for blank issues
    // file one despite the owner's inherited policy disallowing it. Only
    // the first one found is kept — later ones don't change the verdict,
    // they just confirm it.
    let unsupportedReason: string | undefined
    if (asString(obj.type)) {
        unsupportedReason = 'Uses a form feature not supported yet (type)'
    }
    if (!unsupportedReason && asStringArray(obj.projects).length > 0) {
        unsupportedReason = 'Uses a form feature not supported yet (projects)'
    }

    // Seeded with every EXPLICIT id in the form up front — a field whose id
    // is generated later in iteration order must not collide with an
    // explicit id declared further down the body (generateFieldId only
    // guards against ids it has already handed out, not ones still to come).
    //
    // Two EXPLICIT ids colliding with each other is a separate, genuine
    // malformation this same pre-scan loop must also catch (bot review,
    // tiann/hapi#2147, follow-up) — GitHub rejects a form with duplicate
    // ids outright. Below, `fieldId = explicitFieldId ?? generateFieldId(...)`
    // only ever runs generateFieldId's own collision check when there's NO
    // explicit id; two fields both declaring `id: foo` would otherwise both
    // get `fieldId = 'foo'` uncaught, and since both the dialog and the hub
    // key answers by id, the second field's answer silently overwrites the
    // first's, letting one value satisfy two different required fields.
    const usedIds = new Set<string>()
    for (const element of bodyRaw) {
        if (element && typeof element === 'object') {
            const explicitId = asString((element as Record<string, unknown>).id)
            if (explicitId) {
                if (usedIds.has(explicitId)) {
                    return { id, name, kind: 'unsupported', reason: `Template body has a duplicate field id "${explicitId}"`, githubValid: false }
                }
                usedIds.add(explicitId)
            }
        }
    }

    const fields: IssueFormField[] = []
    for (const element of bodyRaw) {
        if (!element || typeof element !== 'object') {
            return { id, name, kind: 'unsupported', reason: 'Template body contains a malformed element', githubValid: false }
        }
        const elObj = element as Record<string, unknown>
        const type = elObj.type
        const attrs = asRecord(elObj.attributes)

        if (type === 'markdown') {
            // `attributes.value` is required for a markdown element — GitHub
            // rejects a form missing it outright (bot review,
            // tiann/hapi#2147, follow-up). Substituting '' used to let a
            // form with this exact malformation parse as a normal, usable
            // field (never caught by any check elsewhere, since markdown
            // carries no label/options to validate) — one GitHub's own
            // chooser would reject, but Boards' own `.github`-inheritance
            // logic would still have counted it as valid local coverage.
            const value = asString(attrs.value)
            if (!value) {
                return { id, name, kind: 'unsupported', reason: 'A "markdown" field is missing a value', githubValid: false }
            }
            fields.push({ kind: 'markdown', value })
            continue
        }

        // `upload` is a real, GitHub-recognized field type (review finding,
        // tiann/hapi#2147, follow-up) — HAPI doesn't render a file picker,
        // so it's still `unsupported` for Boards' own filing path, but it's
        // a type GitHub itself accepts, same "deliberately unsupported
        // feature" treatment as the top-level `type:`/`projects:` keys
        // below. Falling through to the generic unsupported-type branch's
        // githubValid: false would wrongly count an upload-only template
        // as having NO local coverage, letting the owner's `.github`
        // inheritance override a form the repo's own maintainer set up on
        // purpose, GitHub's own chooser would still offer. But that's only
        // true of a genuinely well-formed upload field — one still has to
        // satisfy the same "every non-markdown field needs a label"
        // baseline GitHub enforces on every other type (cold-review
        // follow-up): a label-less upload field is malformed, not merely
        // unsupported, and GitHub's own chooser would never offer it.
        if (type === 'upload') {
            if (!asString(attrs.label)) {
                return { id, name, kind: 'unsupported', reason: 'A "upload" field is missing a label', githubValid: false }
            }
            // Recorded, not returned — see the top-level type:/projects:
            // comment above for why: a later field in this same body can
            // still be genuinely malformed, which must win over this.
            if (!unsupportedReason) unsupportedReason = 'Uses a form feature not supported yet (type: upload)'
            continue
        }
        if (typeof type !== 'string' || !SUPPORTED_FIELD_TYPES.has(type)) {
            return {
                id,
                name,
                kind: 'unsupported',
                reason: `Uses a form feature not supported yet (${typeof type === 'string' ? `type: ${type}` : 'missing field type'})`,
                // SUPPORTED_FIELD_TYPES already matches GitHub's full
                // documented set of issue-form field types — anything
                // outside it isn't a type GitHub itself recognizes either.
                githubValid: false
            }
        }

        const label = asString(attrs.label)
        if (!label) {
            return { id, name, kind: 'unsupported', reason: `A "${type}" field is missing a label`, githubValid: false }
        }
        const explicitFieldId = asString(elObj.id)
        const fieldId = explicitFieldId ?? generateFieldId(label, usedIds)
        const description = asString(attrs.description)
        const validations = asRecord(elObj.validations)
        const required = validations.required === true

        if (type === 'input') {
            fields.push({
                kind: 'input',
                id: fieldId,
                label,
                description,
                placeholder: asString(attrs.placeholder),
                value: asString(attrs.value),
                required,
                minLength: asNumber(validations.min_length)
            })
        } else if (type === 'textarea') {
            fields.push({
                kind: 'textarea',
                id: fieldId,
                label,
                description,
                placeholder: asString(attrs.placeholder),
                value: asString(attrs.value),
                render: asString(attrs.render),
                required,
                minLength: asNumber(validations.min_length)
            })
        } else if (type === 'dropdown') {
            const options = asStringArray(attrs.options)
            if (options.length === 0) {
                return { id, name, kind: 'unsupported', reason: `Dropdown field "${label}" has no options`, githubValid: false }
            }
            // GitHub requires a dropdown's own choices to be distinct (bot
            // review, tiann/hapi#2147, follow-up) — same "genuinely
            // malformed, not merely unsupported" treatment the duplicate
            // field-id check above already gets, and for the same reason:
            // a repository whose only local form has this exact defect
            // would otherwise be wrongly treated as having valid local
            // .github-inheritance coverage.
            if (new Set(options).size !== options.length) {
                return { id, name, kind: 'unsupported', reason: `Dropdown field "${label}" has duplicate options`, githubValid: false }
            }
            fields.push({
                kind: 'dropdown',
                id: fieldId,
                label,
                description,
                options,
                multiple: attrs.multiple === true,
                defaultIndex: typeof attrs.default === 'number' ? attrs.default : undefined,
                required
            })
        } else {
            const rawOptions = Array.isArray(attrs.options) ? attrs.options : []
            const options: IssueFormCheckboxOption[] = []
            for (const rawOption of rawOptions) {
                const optionLabel = asString(asRecord(rawOption).label)
                if (!optionLabel) {
                    return { id, name, kind: 'unsupported', reason: `Checkboxes field "${label}" has a malformed option`, githubValid: false }
                }
                options.push({ label: optionLabel, required: asRecord(rawOption).required === true })
            }
            if (options.length === 0) {
                return { id, name, kind: 'unsupported', reason: `Checkboxes field "${label}" has no options`, githubValid: false }
            }
            fields.push({ kind: 'checkboxes', id: fieldId, label, description, options, required })
        }
    }

    // Only reached once the ENTIRE body has validated clean — see the
    // top-level type:/projects: comment above. Nothing past this point
    // overrides a genuine malformation already returned earlier.
    if (unsupportedReason) {
        return { id, name, kind: 'unsupported', reason: unsupportedReason, githubValid: true }
    }

    return {
        id,
        name,
        description: asString(obj.description),
        titlePrefix: asString(obj.title),
        // GitHub's issue-form schema allows labels/assignees as either a
        // YAML list or a comma-delimited string (review finding) — the same
        // asStringListField the legacy .md parser below already uses for
        // these two fields, not the stricter array-only asStringArray.
        labels: asStringListField(obj.labels),
        assignees: asStringListField(obj.assignees),
        kind: 'form',
        fields,
        revision: hashTemplateRevision(raw)
    }
}

function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
    if (!match) {
        return { frontmatter: {}, body: raw.trim() }
    }
    try {
        const parsed = parseYaml(match[1] ?? '')
        return { frontmatter: asRecord(parsed), body: (match[2] ?? '').trim() }
    } catch {
        // Malformed frontmatter — treat the whole file as plain body, no metadata.
        return { frontmatter: {}, body: raw.trim() }
    }
}

/**
 * GitHub's docs require *some* frontmatter for a legacy `.md` to appear in
 * the chooser at all, but only document `name` as the key every real-world
 * template actually carries — `about` is universal by convention (sampled
 * across 16 major OSS repos), not confirmed as independently enforced. An
 * ordinary markdown file with no (or malformed) frontmatter isn't a
 * template candidate at all, even though `parseLegacyIssueTemplate` itself
 * stays deliberately lenient about it (review finding, tiann/hapi#2147: a
 * repository with `blank_issues_enabled: false` and only such a file would
 * otherwise have its "force a real template" setting defeated by a file
 * GitHub's own UI would never have offered). Checking only `name` closes
 * that gap without the false-negative risk of also requiring `about` for a
 * real template that happens to omit it — this check belongs at the caller
 * deciding *whether a file is a template candidate at all*, not in the
 * parser that answers *how to read one once it's accepted as a candidate* —
 * `parseLegacyIssueTemplate`'s own leniency (falling back to the filename,
 * treating a frontmatter-less file as a usable freeform template) is
 * exercised directly by callers outside Boards' own GitHub-parity discovery
 * loop and is intentionally unaffected by this.
 */
export function hasRequiredLegacyTemplateFrontmatter(raw: string): boolean {
    const { frontmatter } = splitFrontmatter(raw)
    return Boolean(asString(frontmatter.name))
}

/** YAML list or GitHub's comma-separated legacy frontmatter shorthand, both valid for `labels`/`assignees`. */
function asStringListField(value: unknown): string[] {
    if (typeof value === 'string') {
        return value.split(',').map(entry => entry.trim()).filter(Boolean)
    }
    return asStringArray(value)
}

/**
 * Parses a legacy `.github/ISSUE_TEMPLATE/*.md` template (YAML frontmatter +
 * free-text markdown body) — no structured fields, explicitly required
 * alongside `.yml` issue forms (operator decision, hapi#238: repositories
 * that haven't migrated to issue forms are a real case, not an edge case to
 * ignore).
 */
export function parseLegacyIssueTemplate(id: string, raw: string): IssueTemplate {
    const { frontmatter, body } = splitFrontmatter(raw)
    const name = asString(frontmatter.name) ?? id
    // Same "fail loudly" principle the YAML form path above already applies
    // to an unsupported `type:` (review finding, hapi#238): this UI has no
    // way to carry a GitHub issue type through creation, so silently
    // dropping a declared `type:` here would file an untyped issue despite
    // the template's own frontmatter saying otherwise.
    if (asString(frontmatter.type)) {
        return { id, name, kind: 'unsupported', reason: 'Uses a template feature not supported yet (type)', githubValid: true }
    }
    return {
        id,
        name,
        description: asString(frontmatter.about),
        titlePrefix: asString(frontmatter.title),
        labels: asStringListField(frontmatter.labels),
        assignees: asStringListField(frontmatter.assignees),
        kind: 'legacy',
        body,
        revision: hashTemplateRevision(raw)
    }
}

/**
 * `.github/ISSUE_TEMPLATE/config.yml`'s `blank_issues_enabled` flag.
 * Defaults to allowed on any parse failure — a malformed config.yml should
 * never be the reason creation is blocked entirely.
 *
 * `valid` added (review finding, tiann/hapi#2147, follow-up): that same
 * fail-open default is right for "should this repo's own blank-issue
 * check pass," but wrong for "does this count as the repo's own local
 * override of the owner's .github inheritance policy" — an unparseable
 * file provides no actual configuration to override anything with, so
 * `repoHasLocalIssueTemplateCoverage` needs to tell the two apart.
 *
 * A YAML scalar or sequence (`raw: "true"`, `raw: "- a\n- b"`) parses
 * without throwing, so the try/catch alone isn't enough (review finding,
 * tiann/hapi#2147, follow-up) — `asRecord` silently coerces either into
 * `{}`, which would otherwise read as "parsed to an empty-but-valid
 * config" and count as a local override with nothing in it. Requiring the
 * parsed doc itself to be a plain object closes that gap.
 */
export function parseIssueTemplateConfig(raw: string): { blankIssuesEnabled: boolean; valid: boolean } {
    try {
        const doc = parseYaml(raw)
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
            return { blankIssuesEnabled: true, valid: false }
        }
        const obj = asRecord(doc)
        return { blankIssuesEnabled: obj.blank_issues_enabled !== false, valid: true }
    } catch {
        return { blankIssuesEnabled: true, valid: false }
    }
}
