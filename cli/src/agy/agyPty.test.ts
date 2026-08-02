/**
 * Tests for agy readiness / trust / auth-failure markers.
 *
 * Bug context (feat/agy-pty-mode):
 *  - The signed-in startup banner appears before agy's input box is usable.
 *    Treating it as ready let HAPI dequeue and type the first message while agy
 *    could still discard input.
 *  - 'not signed in' was in authFailureMarkers: during sign-in agy transiently
 *    shows "You are currently not signed in. ⣷ Signing in..." which false-
 *    positived the auth-failure path even though auth succeeded a moment later.
 *  - agy added a first-run folder-trust prompt ("Do you trust the contents
 *        of this project?") that --dangerously-skip-permissions does NOT bypass,
 *        so agy blocked at the dialog in any untrusted cwd. AGY_TRUST_MARKERS
 *        now lets runAgentPty auto-approve it.
 *
 * Markers:
 *  - promptMarkers: '? for shortcuts' (verified interactive input footer).
 *  - trustMarkers: 'Do you trust the contents' (folder-trust dialog).
 *  - authFailureMarkers: only 'Select login method' (real OAuth menu), NOT the
 *    transient 'not signed in' banner.
 *  - idleMarkers: the same footer, used again after each agent run.
 *  - idleReadyMs: >= 1000 ms so the signed-in banner render completes before the
 *    first message is submitted.
 */

import { describe, it, expect } from 'vitest'
import {
    AGY_PROMPT_MARKERS,
    AGY_TRUST_MARKERS,
    AGY_AUTH_FAILURE_MARKERS,
    AGY_IDLE_MARKERS,
    AGY_BUSY_MARKERS,
    AGY_IDLE_READY_MS,
    buildAgyPtyArgs,
    buildAgyPtyExtraEnv,
    type AgyPtyOpts,
} from './agyPty'

// Mirror runAgentPty's matcher: strings match as substrings, RegExps via .test().
function anyMarkerMatches(markers: (string | RegExp)[], text: string): boolean {
    return markers.some((m) => (typeof m === 'string' ? text.includes(m) : m.test(text)))
}

// buildAgyPtyArgs only reads agyArgs/resumeSessionId/model; the rest of
// AgyPtyOpts (callbacks) is irrelevant, so a partial cast keeps tests focused.
function argsFor(partial: Partial<AgyPtyOpts>): string[] {
    return buildAgyPtyArgs({ sessionId: null, path: '/tmp', ...partial } as AgyPtyOpts)
}

// ---------------------------------------------------------------------------
// 1. Prompt markers — must match the verified interactive input footer
// ---------------------------------------------------------------------------
describe('AGY_PROMPT_MARKERS', () => {
    it('uses the verified input prompt footer', () => {
        expect(AGY_PROMPT_MARKERS).toContain('? for shortcuts')
    })

    it('does NOT treat the signed-in banner as an interactive prompt', () => {
        const banner = [
            '▄▀▀▄        Antigravity CLI 1.1.8',
            '            lupinogle@gmail.com',
            '            Gemini 3.1 Pro (Low)',
            '            ~',
        ].join('\n')
        expect(anyMarkerMatches(AGY_PROMPT_MARKERS, banner)).toBe(false)
    })

    it('does NOT match the transient pre-auth "not signed in" welcome line', () => {
        // Contains "Antigravity CLI" but with a period, not a version digit — the
        // banner marker must not fire during the sign-in handshake.
        const welcome = 'Welcome to the Antigravity CLI. You are currently not signed in. ⣷ Signing in...'
        expect(anyMarkerMatches(AGY_PROMPT_MARKERS, welcome)).toBe(false)
    })

    it('does NOT match a terminal with no agy banner', () => {
        expect(anyMarkerMatches(AGY_PROMPT_MARKERS, '$ ')).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// 1b. Trust markers — must match agy's first-run folder-trust dialog
// ---------------------------------------------------------------------------
describe('AGY_TRUST_MARKERS', () => {
    it('matches the folder-trust prompt agy shows in an untrusted cwd', () => {
        const trustPrompt = [
            'Do you trust the contents of this project?',
            'Antigravity CLI requires permission to read, edit, and execute files here.',
            '> Yes, I trust this folder',
            '  No, exit',
        ].join('\n')
        expect(anyMarkerMatches(AGY_TRUST_MARKERS, trustPrompt)).toBe(true)
    })

    it('does NOT match the normal signed-in banner (no trust dialog)', () => {
        const banner = '▄▀▀▄        Antigravity CLI 1.1.0'
        expect(anyMarkerMatches(AGY_TRUST_MARKERS, banner)).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// 2. Auth-failure markers — must NOT include the transient "not signed in"
// ---------------------------------------------------------------------------
describe('AGY_AUTH_FAILURE_MARKERS', () => {
    it('contains the real auth-failure marker "Select login method"', () => {
        expect(AGY_AUTH_FAILURE_MARKERS).toContain('Select login method')
    })

    it('does NOT contain "not signed in" (transient during sign-in, causes false-positive)', () => {
        expect(AGY_AUTH_FAILURE_MARKERS).not.toContain('not signed in')
    })

    it('matches the real agy OAuth login menu screen', () => {
        const loginMenu = 'Welcome to Antigravity CLI\n> Select login method\n  Google OAuth'
        expect(AGY_AUTH_FAILURE_MARKERS.some((m) => loginMenu.includes(m))).toBe(true)
    })

    it('does NOT match the transient signing-in banner (false-positive source)', () => {
        // This banner appears DURING successful authentication — must not trigger failure.
        const signingIn = 'Welcome to the Antigravity CLI. You are currently not signed in. ⦷ Signing in...'
        // Only "Select login method" should be a failure signal; the transient
        // "not signed in" text must NOT be in the failure markers.
        const falsePositiveMatch = AGY_AUTH_FAILURE_MARKERS.some((m) => signingIn.includes(m))
        expect(falsePositiveMatch).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// 3. Idle markers — AGY 1.1.5 restored the input-prompt footer
// ---------------------------------------------------------------------------
describe('AGY_IDLE_MARKERS', () => {
    it('uses the verified input prompt footer as the agent-run completion marker', () => {
        expect(AGY_IDLE_MARKERS).toContain('? for shortcuts')
    })
})

// ---------------------------------------------------------------------------
// Busy markers — enable the silence watchdog that clears the thinking state
// ---------------------------------------------------------------------------
describe('AGY_BUSY_MARKERS', () => {
    it('contains the "Generating" spinner text agy 1.0.8 animates while working', () => {
        expect(AGY_BUSY_MARKERS).toContain('Generating')
    })

    it('is non-empty so runAgentPty enables the output-silence watchdog (clears thinking)', () => {
        // With no busy marker hasBusyMarkers is false and the watchdog never runs,
        // leaving the optimistic post-submit thinking=true stuck forever.
        expect(AGY_BUSY_MARKERS.length).toBeGreaterThan(0)
    })

    it('matches a live "Generating..." spinner frame', () => {
        const frame = '⠿  Generating...'
        expect(AGY_BUSY_MARKERS.some((m) => frame.includes(m))).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// 4. Idle-ready window — must be generous enough for the banner render
// ---------------------------------------------------------------------------
describe('buildAgyPtyArgs', () => {
    it('appends --model when a model is set so the picked model takes effect', () => {
        expect(argsFor({ model: 'gemini-3.5-flash-medium' })).toEqual(['--model', 'gemini-3.5-flash-medium'])
    })

    it('omits --model when no model is set (agy uses its own default)', () => {
        expect(argsFor({})).not.toContain('--model')
    })

    it('passes both --conversation and --model on a resumed session with a model', () => {
        const args = argsFor({ resumeSessionId: 'brain-uuid', model: 'claude-opus-4-6-thinking' })
        expect(args).toEqual(['--conversation', 'brain-uuid', '--model', 'claude-opus-4-6-thinking'])
    })
})

describe('AGY_IDLE_READY_MS', () => {
    it('is at least 1000 ms to accommodate banner render after sign-in', () => {
        expect(AGY_IDLE_READY_MS).toBeGreaterThanOrEqual(1000)
    })
})

describe('AGY hook carrier launch configuration', () => {
    it('adds the carrier as a workspace and leaves HOME untouched', () => {
        const opts = { hookCarrierDir: '/tmp/carrier', hookPort: 4312, hookToken: 'secret' } as AgyPtyOpts
        expect(buildAgyPtyArgs(opts)).toEqual(['--add-dir', '/tmp/carrier'])
        expect(buildAgyPtyExtraEnv(opts)).toEqual({
            TERM: 'xterm-256color', GEMINI_FORCE_FILE_STORAGE: 'true',
            HAPI_AGY_HOOK_PORT: '4312', HAPI_AGY_HOOK_TOKEN: 'secret'
        })
    })
})
