import { createHash } from 'node:crypto'
import { parse as parseYaml, parseDocument } from 'yaml'
import type { IssueFormCheckboxOption, IssueFormField, IssueTemplate } from '@hapi/protocol'

/** Hash of a template's raw file content — see IssueTemplateBase.revision. */
function hashTemplateRevision(raw: string): string {
    return createHash('sha256').update(raw).digest('hex')
}

const SUPPORTED_FIELD_TYPES = new Set(['markdown', 'input', 'textarea', 'dropdown', 'checkboxes'])

// GitHub forbids certain words in the `label` of input/textarea elements
// "commonly used by attackers," to limit credentials/PII posted publicly
// in an issue (confirmed against GitHub's own validation-errors doc,
// "Body[i]: label contains forbidden word") — it discloses exactly one
// example, "password," and explicitly states its examples aren't an
// exhaustive list, with no published full list anywhere (deliberately,
// since publishing an anti-abuse filter in full would let it be trivially
// worked around). Checking the one disclosed word is a strict coverage
// improvement with no false rejections.
//
// Previously left unimplemented on the theory that a miss here fails
// visibly, not silently: `gh issue create --title --body` was assumed to
// get re-validated against the originating form schema the same way
// GitHub's own form UI would reject it. It doesn't — GitHub's REST
// issue-create call has no concept of the originating .yml template at
// all, so a forbidden-word label that slips past this check is never
// validated by anyone; the issue gets created exactly as filled in (bot
// review, tiann/hapi#2147, follow-up). Checked against `kind: 'unsupported'`
// the same way every other GitHub-documented template-validity rule in
// this file is — a repo whose only local template has this flaw must NOT
// count as having valid local coverage, same as a duplicate id or a
// reserved dropdown word wouldn't.
const FORBIDDEN_LABEL_WORDS = ['password']

function containsForbiddenLabelWord(label: string): boolean {
    const lower = label.toLowerCase()
    return FORBIDDEN_LABEL_WORDS.some(word => lower.includes(word))
}

// GitHub's own attribute tables, one per field type (confirmed directly
// against GitHub's documented form-schema syntax) — the full permitted
// set, used to reject an unrecognized attribute key (see the main parse
// loop's own comment for why this needed checking at all).
const PERMITTED_FIELD_ATTRIBUTES: Record<string, Set<string>> = {
    markdown: new Set(['value']),
    input: new Set(['label', 'description', 'placeholder', 'value']),
    textarea: new Set(['label', 'description', 'placeholder', 'value', 'render']),
    dropdown: new Set(['label', 'description', 'multiple', 'options', 'default']),
    checkboxes: new Set(['label', 'description', 'options']),
    upload: new Set(['label', 'description'])
}

// The keys a body element itself may carry, sibling to the attribute
// check above but one level shallower (confirmed directly against
// GitHub's validation-errors page) — exactly the set this parser already
// reads off `elObj` elsewhere in this file.
const PERMITTED_BODY_ELEMENT_KEYS = new Set(['type', 'id', 'attributes', 'validations'])

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined
}

// GitHub's own docs state this explicitly, for both a top-level key and a
// field's own `label` (bot review, tiann/hapi#2147, follow-up, confirmed
// directly against GitHub's validation-errors page): "Empty strings, or
// strings consisting of only whitespaces, are also not permissible when
// the field expects a string." A bare `!asString(...)` check only ever
// caught the non-string case (a Boolean-coerced value) and an EMPTY
// string — a whitespace-only one (`description: "   "`) is truthy in JS
// and silently passed every required-string check in this file.
function asNonBlankString(value: unknown): string | undefined {
    const str = asString(value)
    return str && str.trim().length > 0 ? str : undefined
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
// (GitHub's own fallback source), slugified (review finding: rejecting the
// whole template over a missing id makes an otherwise-valid, GitHub-accepted
// form unusable in Boards).
//
// Transliterates Latin diacritics before stripping non-ASCII characters
// (Meta review follow-up, tiann/hapi#2147) — GitHub's own documented
// mechanism for this is Rails' `parameterize`, which transliterates first
// ("Jürgen" -> "Jurgen") rather than just deleting non-ASCII characters
// outright. Skipping that step disagreed with GitHub's real behavior in
// BOTH directions for any accented label, confirmed with concrete
// examples: "Café" (ours: "caf") vs "Cafe" (ours: "cafe") don't collide
// here but DO under Rails' transliteration ("cafe" both), a collision
// this parser would silently miss; "Café" (ours: "caf") vs "Caf" (ours:
// "caf") DO collide here but DON'T under Rails ("cafe" vs "caf"), which
// this parser's own collision check would now wrongly reject since it
// rejects on collision (see generateFieldId below) — a false reject is
// the worse direction (blocks a legitimately GitHub-valid, non-English
// template outright), and non-ASCII labels aren't hypothetical for a
// project that ships Japanese/Chinese/Russian localization. NFD
// normalization plus stripping combining marks covers composed Latin
// diacritics (the cases above, and most of Western/Central European
// text); the handful of single-codepoint Latin letters Rails' own docs
// call out by name (ß, æ, ø, ...) get an explicit map since they have no
// combining-mark decomposition to strip. Not a byte-for-byte replica of
// Rails' full locale-aware transliteration table (which even varies by
// configured I18n locale, e.g. German ü -> "ue" vs the ASCII-default
// "u" used here) — just enough to stop the concrete false-accept/
// false-reject pairs above. CJK and other scripts with no Latin
// approximation are unaffected by this and don't need their own
// handling: Rails' own `transliterate` replaces an unmappable character
// with "?" (confirmed in its own docs), which `slugify`'s cleanup below
// strips like any other non-alphanumeric character, so an all-CJK label
// already parameterizes to the same empty string under Rails as it does
// here (falling through to the `'field'` fallback) — two different
// CJK-only labels colliding on that shared fallback matches GitHub's
// real behavior already, not a gap.
function transliterate(label: string): string {
    return label
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/ß/g, 'ss').replace(/[æÆ]/g, 'ae').replace(/[œŒ]/g, 'oe')
        .replace(/[øØ]/g, 'o').replace(/[þÞ]/g, 'th').replace(/[ðÐ]/g, 'd').replace(/[łŁ]/g, 'l')
}

// GitHub's docs quote Rails' `parameterize` as preserving dashes AND
// underscores "unless they are used as separators" (bot review follow-up)
// — e.g. "Jolie__" stays "jolie__", not "jolie--" or "jolie". The previous
// version replaced ANY non-alphanumeric run with a dash, which silently
// turned every underscore into a dash too — so "Name_US" and "Name-US"
// collided here ("name-us" both) even though real `parameterize` keeps
// them distinct ("name_us" vs "name-us"), the same "we reject on a
// collision GitHub wouldn't actually see" risk the diacritic fix above
// exists to close. Underscores (and the separator dash itself) are now
// excluded from the "strip this" character class; only RUNS of the
// actual separator character get collapsed/trimmed at the edges, same as
// Rails only collapses/strips the separator, never an unrelated character
// that happens to look like one.
//
// Full divergence surface against `parameterize`'s own five steps (Meta
// review, follow-up, enumerated and verified against this exact
// implementation rather than left as "nothing else has surfaced yet"):
// (1) transliterate — `transliterate()` above; (2) replace runs outside
// `[a-z0-9_-]` with the separator, (3) collapse runs of the separator,
// (4) strip it from the ends, (5) downcase — steps (2)-(5) below. Steps
// 3-5 were already correct before this round; only 1 and 2 needed fixing.
function slugify(label: string): string {
    const slug = transliterate(label).toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '')
    return slug || 'field'
}

// GitHub documents this exact collision as its own validation error,
// "Labels are too similar" (bot review follow-up), confirmed directly
// against https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/common-validation-errors-when-creating-issue-forms#labels-are-too-similar
// — if an idless field's label parameterizes to a reference another field
// already claims — another idless field's label, OR another field's
// *explicit* id — GitHub rejects the form outright. GitHub's own
// documented example pairs an idless "Name?" against an explicit `id:
// name` field with label "Name???????" and rejects it, even though the
// labels are literally different text. A numeric suffix used to paper
// over this (silently handing out `name-us-2`) instead of rejecting,
// which is the same "malformed template silently tolerated, wrongly
// counted as local .github coverage" class as every other
// duplicate-identifier check in this file. No suffix retry: a collision
// is a rejection, not something to resolve.
function generateFieldId(label: string, usedIds: Set<string>): string | undefined {
    const candidate = slugify(label)
    if (usedIds.has(candidate)) return undefined
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
    // Parsed via the CST-preserving `parseDocument` (not the plain `parse`)
    // so dropdown options can be checked for literal quoting below — see
    // the dropdown branch's own comment for why that distinction matters.
    // `parseDocument` never throws; malformed YAML surfaces in `.errors`
    // instead, with `.toJS()` still producing a best-effort (and here,
    // unusable) result alongside it. `.toJS()` itself CAN still throw
    // (bot review, tiann/hapi#2147, follow-up, confirmed directly: an
    // anchor/alias expansion deep enough to look like a resource-
    // exhaustion attack throws "Excessive alias count..." from `.toJS()`
    // even though `.errors` is empty at that point) — the plain `parse()`
    // this replaced wrapped exactly this in one call, so the try/catch
    // around it already covered this failure mode; splitting the parse
    // from the convert step dropped that coverage for the convert half.
    // One malformed template throwing uncaught here would crash whatever
    // caller is listing ALL of a repo's templates, not just mark this one
    // unsupported.
    let cstDoc: ReturnType<typeof parseDocument>
    let doc: unknown
    try {
        cstDoc = parseDocument(raw)
        if (cstDoc.errors.length > 0) {
            return { id, name: id, kind: 'unsupported', reason: 'Could not parse this template\'s YAML', githubValid: false }
        }
        doc = cstDoc.toJS()
    } catch {
        return { id, name: id, kind: 'unsupported', reason: 'Could not parse this template\'s YAML', githubValid: false }
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        return { id, name: id, kind: 'unsupported', reason: 'Template is not a valid issue form', githubValid: false }
    }
    const obj = doc as Record<string, unknown>
    // GitHub's own top-level syntax table documents exactly these eight
    // keys (bot review, tiann/hapi#2147, follow-up, confirmed directly
    // against GitHub's docs) and rejects any other top-level key outright
    // ("`input` is not a permitted key") — nothing here ever checked for
    // one. This is the SAME mechanism, not a separate check, as GitHub's
    // documented "Forbidden keys" list (y/yes/true/off/...): those exist
    // because an unquoted boolean-like key could otherwise slip past a
    // permitted-key check that only looked at known boolean-ish names —
    // here, any key outside this exact set is rejected regardless of
    // what it looks like, so a form using one of those names as a key
    // gets caught the same way a typo'd key would, with no separate list
    // to maintain.
    const PERMITTED_TOP_LEVEL_KEYS = new Set(['name', 'description', 'body', 'assignees', 'labels', 'title', 'type', 'projects'])
    for (const key of Object.keys(obj)) {
        if (!PERMITTED_TOP_LEVEL_KEYS.has(key)) {
            return { id, name: id, kind: 'unsupported', reason: `Template has an unexpected top-level key "${key}"`, githubValid: false }
        }
    }
    // GitHub requires `name` on an issue form — the legacy .md path
    // already enforces this via hasRequiredLegacyTemplateFrontmatter, but
    // this .yml path fell back to the filename instead of rejecting it,
    // so a file missing it was accepted as a usable form and counted
    // toward local .github-inheritance coverage even though GitHub's own
    // chooser would never have offered it (review finding, tiann/hapi#2147).
    const name = asNonBlankString(obj.name)
    if (!name) {
        return { id, name: id, kind: 'unsupported', reason: 'Template is missing the required "name" field', githubValid: false }
    }
    // Not documented on GitHub's own syntax/validation-errors pages (both
    // checked directly — neither mentions a length minimum), but confirmed
    // real via multiple independent real-world repos hitting GitHub's own
    // in-editor error "Name is too short (minimum is 3 characters)" (bot
    // review, tiann/hapi#2147, follow-up) — a template named "Bug" (3
    // characters) meets that minimum and would be offered by GitHub's own
    // chooser; the review's own example used it as a rejection case, which
    // the literal GitHub error string contradicts. Threshold here matches
    // the quoted error exactly: fewer than 3 is rejected, 3 or more passes.
    if (name.length < 3) {
        return { id, name, kind: 'unsupported', reason: `Template name "${name}" is too short (GitHub requires at least 3 characters)`, githubValid: false }
    }
    // `description` is required alongside `name` per GitHub's own top-level
    // syntax table (review finding, tiann/hapi#2147, follow-up on the name
    // check above) — a form missing it isn't one GitHub's own template
    // editor would even save, let alone offer in the chooser.
    if (!asNonBlankString(obj.description)) {
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
    // GitHub's own schema restricts an explicit `id` to "alpha-numeric
    // characters, `-`, and `_`" (bot review, tiann/hapi#2147, follow-up,
    // confirmed directly against GitHub's documented form-schema syntax
    // table) — a stricter character set than the dialog or hub ever
    // enforced. An id outside that set (a space, punctuation, anything
    // non-ASCII) is itself malformed, same "GitHub's own chooser would
    // reject this whole form" class as every other check in this loop,
    // checked before the duplicate check below so a malformed id doesn't
    // first get silently treated as a normal, unique one.
    const VALID_EXPLICIT_ID = /^[a-zA-Z0-9_-]+$/
    const usedIds = new Set<string>()
    for (const element of bodyRaw) {
        if (element && typeof element === 'object') {
            const explicitId = asString((element as Record<string, unknown>).id)
            if (explicitId) {
                if (!VALID_EXPLICIT_ID.test(explicitId)) {
                    return { id, name, kind: 'unsupported', reason: `Template body has an invalid field id "${explicitId}" (ids may only use letters, numbers, "-", and "_")`, githubValid: false }
                }
                if (usedIds.has(explicitId)) {
                    return { id, name, kind: 'unsupported', reason: `Template body has a duplicate field id "${explicitId}"`, githubValid: false }
                }
                usedIds.add(explicitId)
            }
        }
    }

    // GitHub's own rule (confirmed against its documented validation
    // errors, "Body must have unique labels") is narrower than "every
    // label must be unique": two fields sharing a label are fine as long
    // as AT LEAST ONE of them carries an explicit `id` — the `id` is
    // explicitly GitHub's own escape hatch for intentionally-identical
    // labels. It's only invalid when NEITHER field has one. This
    // parser's own `generateFieldId` used to paper over exactly that
    // case with a numeric suffix (treating it as a harmless internal
    // disambiguation), which is the bug (bot review, tiann/hapi#2147,
    // follow-up): a form GitHub itself rejects outright was instead
    // accepted as normal and usable, wrongly counting as local
    // `.github`-inheritance coverage.
    const idlessLabels = new Set<string>()
    const fields: IssueFormField[] = []
    for (const [elementIndex, element] of bodyRaw.entries()) {
        if (!element || typeof element !== 'object') {
            return { id, name, kind: 'unsupported', reason: 'Template body contains a malformed element', githubValid: false }
        }
        const elObj = element as Record<string, unknown>

        // GitHub documents this as its own validation error, "Body[i]: `x`
        // is not a permitted key" (bot review, tiann/hapi#2147, follow-up,
        // confirmed directly against GitHub's validation-errors page: "An
        // unexpected key... was provided at the same indentation level as
        // `type` and `attributes`") — a sibling rule to the attribute-key
        // check just below, one level shallower: this one's about keys on
        // the body ELEMENT itself (`type`/`id`/`attributes`/`validations`,
        // the exact set this parser already reads from `elObj`), not keys
        // nested inside `attributes:`. An unrecognized key here was never
        // checked at all.
        const unexpectedElementKey = Object.keys(elObj).find(key => !PERMITTED_BODY_ELEMENT_KEYS.has(key))
        if (unexpectedElementKey !== undefined) {
            return { id, name, kind: 'unsupported', reason: `Template body has a field with an unexpected key "${unexpectedElementKey}"`, githubValid: false }
        }

        const type = elObj.type
        const attrs = asRecord(elObj.attributes)

        // GitHub documents this as its own validation error, "Body[i]: `x`
        // is not a permitted attribute" (bot review, tiann/hapi#2147,
        // follow-up, confirmed directly against GitHub's validation-errors
        // page) — an unrecognized key inside a field's `attributes:` block
        // invalidates the whole form, the same "GitHub's own chooser would
        // reject this" class as the unexpected-top-level-key check above,
        // one level deeper. This parser read only the attributes it knew
        // about and silently ignored anything extra, which could let a
        // malformed template still classify as usable.
        const permittedAttrs = typeof type === 'string' ? PERMITTED_FIELD_ATTRIBUTES[type] : undefined
        if (permittedAttrs) {
            const unexpectedAttr = Object.keys(attrs).find(key => !permittedAttrs.has(key))
            if (unexpectedAttr !== undefined) {
                return { id, name, kind: 'unsupported', reason: `A "${type}" field has an unexpected attribute "${unexpectedAttr}"`, githubValid: false }
            }
        }

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
            const uploadLabel = asNonBlankString(attrs.label)
            if (!uploadLabel) {
                return { id, name, kind: 'unsupported', reason: 'A "upload" field is missing a label', githubValid: false }
            }
            if (!asString(elObj.id)) {
                if (idlessLabels.has(uploadLabel)) {
                    return { id, name, kind: 'unsupported', reason: `Template body has a duplicate label "${uploadLabel}" with no distinguishing id`, githubValid: false }
                }
                idlessLabels.add(uploadLabel)
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

        const label = asNonBlankString(attrs.label)
        if (!label) {
            return { id, name, kind: 'unsupported', reason: `A "${type}" field is missing a label`, githubValid: false }
        }
        if ((type === 'input' || type === 'textarea') && containsForbiddenLabelWord(label)) {
            return { id, name, kind: 'unsupported', reason: `Field "${label}" uses a word GitHub forbids in an input/textarea label ("password")`, githubValid: false }
        }
        const explicitFieldId = asString(elObj.id)
        if (!explicitFieldId) {
            if (idlessLabels.has(label)) {
                return { id, name, kind: 'unsupported', reason: `Template body has a duplicate label "${label}" with no distinguishing id`, githubValid: false }
            }
            idlessLabels.add(label)
        }
        const generatedFieldId = explicitFieldId ? undefined : generateFieldId(label, usedIds)
        if (!explicitFieldId && generatedFieldId === undefined) {
            return { id, name, kind: 'unsupported', reason: `Field "${label}" generates the same identifier as another field in this form ("Labels are too similar")`, githubValid: false }
        }
        const fieldId = explicitFieldId ?? generatedFieldId as string
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
            // GitHub documents this as its own validation error (bot
            // review, tiann/hapi#2147, follow-up, confirmed directly
            // against GitHub's validation-errors page): an unquoted
            // option like `true`/`false` parses as a YAML Boolean, not a
            // string, and GitHub rejects the whole form over it. Checked
            // against the RAW array, before `asStringArray` below quietly
            // filters non-strings out — that filtering is exactly the bug:
            // a two-option dropdown where one option parsed as a Boolean
            // used to silently become a one-option dropdown that still
            // passed every check below, rather than the malformed template
            // it actually is.
            const rawOptions = Array.isArray(attrs.options) ? attrs.options : []
            if (rawOptions.some(option => typeof option !== 'string')) {
                return { id, name, kind: 'unsupported', reason: `Dropdown field "${label}" has an option that YAML parsed as a non-string value — wrap it in quotes`, githubValid: false }
            }
            // The check above alone isn't enough (bot review, tiann/hapi#2147,
            // follow-up): this codebase's own `yaml` dependency only coerces
            // literal `true`/`false` to a non-string — it leaves GitHub's
            // other cited examples (bare `yes`, `no`, `on`, `off`, any case)
            // as plain strings, confirmed directly by parsing them. GitHub's
            // own backend parser (the authority `githubValid` answers to)
            // coerces those too, so an unquoted `- Yes` is a string here but
            // a Boolean there, and GitHub rejects it while this parser,
            // checking only the already-resolved JS value, could not tell
            // the difference between that and a legitimately quoted `"Yes"`
            // — both arrive as the identical string. Resolved by reading
            // this specific options array from the CST instead of the
            // plain object: `parseDocument` preserves each scalar's actual
            // quote style (`PLAIN` vs `QUOTE_SINGLE`/`QUOTE_DOUBLE`), which
            // is exactly the information GitHub's own parser is reacting
            // to and this codebase's plain `.toJS()` value discards.
            const optionsNode = cstDoc.getIn(['body', elementIndex, 'attributes', 'options'], true) as { items?: { type?: string }[] } | undefined
            const BOOLEAN_WORDS = new Set(['y', 'yes', 'n', 'no', 'true', 'false', 'on', 'off'])
            if (optionsNode?.items?.some((item, i) =>
                item.type === 'PLAIN' && BOOLEAN_WORDS.has(String(rawOptions[i]).toLowerCase())
            )) {
                return { id, name, kind: 'unsupported', reason: `Dropdown field "${label}" has an unquoted option GitHub's own parser would read as a Boolean — wrap it in quotes`, githubValid: false }
            }
            const options = rawOptions as string[]
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
            // "None" is a reserved word GitHub auto-populates as the
            // non-choice option on an optional dropdown (bot review,
            // tiann/hapi#2147, follow-up, confirmed directly against
            // GitHub's validation-errors page) — a template declaring it
            // explicitly is one GitHub's own chooser rejects outright.
            if (options.includes('None')) {
                return { id, name, kind: 'unsupported', reason: `Dropdown field "${label}" uses "None", a reserved option GitHub auto-populates`, githubValid: false }
            }
            const defaultIndex = typeof attrs.default === 'number' ? attrs.default : undefined
            // GitHub's own form-schema syntax table states this as part
            // of `default`'s own description (bot review, tiann/hapi#2147,
            // follow-up, confirmed directly against GitHub's docs): "When
            // a default option is specified, you cannot include 'None' or
            // 'n/a' as options." Unlike "None" (rejected unconditionally
            // above, per its own dedicated validation-error entry), "n/a"
            // has no such entry — this table is the only place GitHub
            // documents it, and it's explicit that the restriction is
            // conditional on `default` being set, not a blanket ban.
            if (defaultIndex !== undefined && options.some(option => option.toLowerCase() === 'n/a')) {
                return { id, name, kind: 'unsupported', reason: `Dropdown field "${label}" combines a default with the forbidden "n/a" option`, githubValid: false }
            }
            fields.push({
                kind: 'dropdown',
                id: fieldId,
                label,
                description,
                options,
                multiple: attrs.multiple === true,
                defaultIndex,
                required
            })
        } else {
            const rawOptions = Array.isArray(attrs.options) ? attrs.options : []
            const options: IssueFormCheckboxOption[] = []
            for (const rawOption of rawOptions) {
                const optionLabel = asNonBlankString(asRecord(rawOption).label)
                if (!optionLabel) {
                    return { id, name, kind: 'unsupported', reason: `Checkboxes field "${label}" has a malformed option`, githubValid: false }
                }
                // GitHub's own docs state this explicitly — "Checkboxes
                // must have unique labels" — as broader than "distinct
                // within this one field": a nested checkbox option's
                // label must be unique "among its peers, as well as
                // among other input types" (bot review, tiann/hapi#2147,
                // follow-up, confirmed directly against GitHub's
                // validation-errors page, whose own example rejects a
                // checkbox option labelled "Name" against an unrelated
                // textarea field also labelled "Name"). A checkbox
                // option can never carry its own `id` (GitHub's docs:
                // "Nested checkbox elements do not support the id
                // attribute"), so every option label is checked against
                // the SAME idlessLabels pool every other idless field
                // label uses, not a separate per-field set — catching a
                // same-field duplicate the same way it catches a
                // cross-field one. This codebase's own
                // validateIssueFormAnswers checks a checked answer
                // against the field's declared option labels by string
                // match, so a duplicate makes a required-option check
                // satisfiable by an ambiguous value, and the dialog
                // renders and keys both checkboxes by that same label,
                // with no way for the user to tell which one they ticked.
                if (idlessLabels.has(optionLabel)) {
                    return { id, name, kind: 'unsupported', reason: `Checkboxes field "${label}" has an option labelled "${optionLabel}" that collides with another field's label`, githubValid: false }
                }
                idlessLabels.add(optionLabel)
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
