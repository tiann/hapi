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

test.use({
    ...devices['Pixel 5'],
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 1,
    launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] }
})

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

for (const isMobile of [true, false]) {
    test.describe(`touch scrollbar resize containment (mobile: ${isMobile})`, () => {
        // A touch-capable desktop context also exercises physical scrollbars.
        test.use({ isMobile, hasTouch: true })

        test('keeps two expanded projects stable while the fallback thumb catches up with a shorter viewport', async ({ page }) => {
            await page.addInitScript(() => localStorage.setItem('hapi-session-preview-limit', '99'))
            await page.goto('/e2e-fixtures/session-list-scrollbar-fixture.html?two-projects')
            const viewport = page.locator('.session-list-scrollbar-left')
            await expect(viewport).toBeVisible()
            await expect(viewport.locator('.collapsible-panel[data-open]')).toHaveCount(2)

            const samples = await viewport.evaluate(async (element) => {
                const root = document.documentElement
                const toolbarHeight = element.getBoundingClientRect().top
                const contentHeight = element.firstElementChild!.getBoundingClientRect().height
                const height = contentHeight + toolbarHeight - 32
                const setHeight = (value: number) => {
                    root.style.height = `${value}px`
                    document.body.style.height = `${value}px`
                }
                setHeight(height)
                const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
                await nextFrame()
                await nextFrame()
                element.scrollTop = element.scrollHeight
                await nextFrame()
                await nextFrame()

                const measure = () => ({
                    width: element.getBoundingClientRect().width,
                    bodyOverflow: document.body.scrollHeight - document.body.clientHeight,
                    scrollTop: element.scrollTop
                })
                const frames = [measure()]
                // Read layout synchronously after resizing, before ResizeObserver
                // and the scheduled fallback-thumb update can run.
                setHeight(height - 48)
                element.scrollTop = element.scrollHeight
                frames.push(measure())
                for (let index = 0; index < 8; index++) {
                    await nextFrame()
                    frames.push(measure())
                }
                return frames
            })

            await test.info().attach('resize geometry', { body: JSON.stringify(samples), contentType: 'application/json' })

            // The list must keep scrolling without making its ancestors scroll
            // or changing its width, including before the thumb geometry updates.
            expect(samples.every(sample => sample.scrollTop > 0)).toBe(true)
            expect(samples.filter(sample => sample.bodyOverflow > 1)).toEqual([])
            expect(samples.every(sample => sample.width === samples[0].width)).toBe(true)
        })
    })
}
