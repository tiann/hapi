/**
 * Playwright screencast helpers — click highlights + animated pointer on recorded video.
 *
 * Requires Playwright >= 1.59 (screencast.showActions); cursor animation needs >= 1.61.
 *
 * @playwright/test fixtures:
 *   import { annotatedVideoUseOption } from './scripts/dev/playwright-annotated-video.mjs'
 *   use: { video: process.env.PLAYWRIGHT_RECORD_VIDEO === '1' ? annotatedVideoUseOption('on') : 'off' }
 *
 * Programmatic (handoff .mjs scripts):
 *   import { startAnnotatedScreencast, stopAnnotatedScreencast } from './playwright-annotated-video.mjs'
 *   await startAnnotatedScreencast(page, { path: 'localdocs/playwright-runs/demo.webm' })
 *   // ... interactions ...
 *   await stopAnnotatedScreencast(page)
 */

/** Default overlays: element outline, action title, pointer glide between clicks. */
export const ANNOTATED_SHOW_ACTIONS = {
    position: 'top-right',
    cursor: 'pointer',
    duration: 800,
    fontSize: 22,
}

/**
 * `use.video` value for @playwright/test when recording with action annotations.
 * @param {import('@playwright/test').VideoMode} mode
 * @param {import('@playwright/test').ViewportSize | undefined} size
 */
export function annotatedVideoUseOption(mode = 'on', size) {
    const option = {
        mode,
        show: {
            actions: {
                position: ANNOTATED_SHOW_ACTIONS.position,
                duration: ANNOTATED_SHOW_ACTIONS.duration,
                fontSize: ANNOTATED_SHOW_ACTIONS.fontSize,
            },
        },
    }
    if (size) option.size = size
    return option
}

export function shouldRecordAnnotatedVideo() {
    return process.env.HAPI_PEER_RECORD_VIDEO === '1' || process.env.PLAYWRIGHT_RECORD_VIDEO === '1'
}

/**
 * Start annotated screencast on a page (replaces raw `recordVideo` on browser context).
 * @param {import('playwright').Page} page
 * @param {{ path: string, showActions?: typeof ANNOTATED_SHOW_ACTIONS, size?: { width: number, height: number } }} options
 */
export async function startAnnotatedScreencast(page, options) {
    const { path, showActions = ANNOTATED_SHOW_ACTIONS, size } = options
    await page.screencast.start({ path, size })
    await page.screencast.showActions(showActions)
}

/** Stop screencast and finalize the file written by {@link startAnnotatedScreencast}. */
export async function stopAnnotatedScreencast(page) {
    await page.screencast.stop()
}

/** Resolve webm/mp4 paths under a handoff output directory. */
export function annotatedVideoPaths(dir, basename) {
    const webm = `${dir.replace(/\/$/, '')}/${basename}.webm`
    const mp4 = `${dir.replace(/\/$/, '')}/${basename}.mp4`
    return { webm, mp4 }
}
