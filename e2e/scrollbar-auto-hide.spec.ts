import { devices, expect, test, type Locator } from '@playwright/test'

const SCROLLBAR_ATTRIBUTE = 'data-scrollbar-visible'
const HIDE_DELAY_MS = 1_000
const FADE_DURATION = '0.3s'

async function expectScrollbarToHide(locator: Locator) {
    await expect.poll(async () => locator.getAttribute(SCROLLBAR_ATTRIBUTE), {
        timeout: HIDE_DELAY_MS + 2_000,
        intervals: [100, 250]
    }).toBeNull()
}

test.use({ ...devices['Pixel 5'], viewport: { width: 412, height: 915 }, deviceScaleFactor: 1 })

test.describe('session scrollbar auto-hide', () => {
    test.describe.configure({ timeout: 60_000 })

    test('hides the session list scrollbar after one second and keeps it visible on focus', async ({ page }) => {
        await page.goto('/e2e-fixtures/session-list-scrollbar-fixture.html')

        const viewport = page.locator('.session-list-scrollbar-left')
        await expect(viewport).toBeVisible()
        const fallback = page.locator('.transient-scrollbar-fallback-left')
        const fallbackThumb = fallback.locator('.transient-scrollbar-fallback-thumb')
        await expect(fallback).toBeVisible()
        await expect(fallback).toHaveAttribute('data-visible', 'true')
        await expect(fallbackThumb).toHaveCSS('transition-property', /opacity/)
        const transitions = await viewport.evaluate((element) => ({
            surface: getComputedStyle(element).transitionProperty,
            surfaceDuration: getComputedStyle(element).transitionDuration,
            thumb: getComputedStyle(element, '::-webkit-scrollbar-thumb').transitionProperty,
            thumbDuration: getComputedStyle(element, '::-webkit-scrollbar-thumb').transitionDuration,
        }))
        expect(transitions.surface).toContain('scrollbar-color')
        expect(transitions.surfaceDuration).toBe(FADE_DURATION)
        expect(transitions.thumb).toContain('background-color')
        expect(transitions.thumbDuration).toBe(FADE_DURATION)
        await expect(fallbackThumb).toHaveCSS('transition-duration', FADE_DURATION)
        await expect(viewport).toHaveAttribute(SCROLLBAR_ATTRIBUTE, 'true')
        await expectScrollbarToHide(viewport)
        await expect(fallback).not.toHaveAttribute('data-visible')
        await expect(fallbackThumb).toHaveCSS('opacity', '0')

        await viewport.evaluate((element) => {
            element.scrollTop = Math.min(200, element.scrollHeight)
            element.dispatchEvent(new Event('scroll'))
        })
        await expect(viewport).toHaveAttribute(SCROLLBAR_ATTRIBUTE, 'true')
        await expect(fallback).toHaveAttribute('data-visible', 'true')
        await expect(fallbackThumb).toHaveCSS('opacity', '1')
        await expectScrollbarToHide(viewport)
        await expect(fallback).not.toHaveAttribute('data-visible')

        await viewport.locator('button').first().focus()
        await expect(viewport).toHaveAttribute(SCROLLBAR_ATTRIBUTE, 'true')
        await expect(fallback).toHaveAttribute('data-visible', 'true')
        await page.waitForTimeout(HIDE_DELAY_MS + 200)
        await expect(viewport).toHaveAttribute(SCROLLBAR_ATTRIBUTE, 'true')
        await expect(fallback).toHaveAttribute('data-visible', 'true')
    })

    test('hides the main chat scrollbar after one second and keeps it visible on focus', async ({ page }) => {
        await page.goto('/e2e-fixtures/history-load-fixture.html')

        const viewport = page.locator('.chat-scroll-y')
        await expect(viewport).toBeVisible()
        const fallback = page.locator('.transient-scrollbar-fallback-right')
        const fallbackThumb = fallback.locator('.transient-scrollbar-fallback-thumb')
        await expect(fallback).toBeVisible()
        await expect(fallback).toHaveAttribute('data-visible', 'true')
        await expect(fallbackThumb).toHaveCSS('transition-property', /opacity/)
        const transitions = await viewport.evaluate((element) => ({
            surface: getComputedStyle(element).transitionProperty,
            surfaceDuration: getComputedStyle(element).transitionDuration,
            thumb: getComputedStyle(element, '::-webkit-scrollbar-thumb').transitionProperty,
            thumbDuration: getComputedStyle(element, '::-webkit-scrollbar-thumb').transitionDuration,
        }))
        expect(transitions.surface).toContain('scrollbar-color')
        expect(transitions.surfaceDuration).toBe(FADE_DURATION)
        expect(transitions.thumb).toContain('background-color')
        expect(transitions.thumbDuration).toBe(FADE_DURATION)
        await expect(fallbackThumb).toHaveCSS('transition-duration', FADE_DURATION)
        await expect(viewport).toHaveAttribute(SCROLLBAR_ATTRIBUTE, 'true')
        await expectScrollbarToHide(viewport)
        await expect(fallback).not.toHaveAttribute('data-visible')
        await expect(fallbackThumb).toHaveCSS('opacity', '0')

        await viewport.evaluate((element) => {
            element.dispatchEvent(new Event('scroll'))
        })
        await expect(viewport).toHaveAttribute(SCROLLBAR_ATTRIBUTE, 'true')
        await expect(fallback).toHaveAttribute('data-visible', 'true')
        await expect(fallbackThumb).toHaveCSS('opacity', '1')
        await expectScrollbarToHide(viewport)
        await expect(fallback).not.toHaveAttribute('data-visible')

        await viewport.focus()
        await expect(viewport).toHaveAttribute(SCROLLBAR_ATTRIBUTE, 'true')
        await expect(fallback).toHaveAttribute('data-visible', 'true')
        await page.waitForTimeout(HIDE_DELAY_MS + 200)
        await expect(viewport).toHaveAttribute(SCROLLBAR_ATTRIBUTE, 'true')
        await expect(fallback).toHaveAttribute('data-visible', 'true')
    })
})
