import { expect, test } from '@playwright/test'

const fixtureUrl = '/e2e-fixtures/generated-media-tiny-fixture.html'
const card = '[data-hapi-generated-media-id="tiny-16x32"]'
const image = `${card} img`

// The jsdom suite can only prove which inline style we set. This spec measures
// the real box: a tiny preview enlarged with `transform: scale()` paints outside
// the space its `w-fit` card reserves, so the card would overlap the following
// chat content instead of pushing it down.
test.describe('generated media tiny preview geometry', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(fixtureUrl)
        await expect(page.locator(image)).toBeVisible()
    })

    test('reserves the painted size in layout flow for a skinny tiny image', async ({ page }) => {
        const probe = await page.locator(image).evaluate((element) => {
            const img = element as HTMLImageElement
            const rect = img.getBoundingClientRect()
            return {
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                width: rect.width,
                height: rect.height,
                transform: getComputedStyle(img).transform
            }
        })

        expect(probe.naturalWidth).toBe(16)
        expect(probe.naturalHeight).toBe(32)
        // 16x32 doubles to 32x64 (MIN_INLINE_IMAGE_DIMENSION / maxDim).
        expect(probe.width).toBeCloseTo(32, 1)
        expect(probe.height).toBeCloseTo(64, 1)
        // A transform would make the painted box diverge from the layout box.
        expect(probe.transform).toBe('none')
    })

    test('keeps the enlarged image inside its card and clear of following content', async ({ page }) => {
        const geometry = await page.evaluate((cardSelector) => {
            const cardElement = document.querySelector(cardSelector)!
            const imageElement = cardElement.querySelector('img')!
            const follower = document.querySelector('[data-testid="follower"]')!
            const cardRect = cardElement.getBoundingClientRect()
            const imageRect = imageElement.getBoundingClientRect()
            const followerRect = follower.getBoundingClientRect()
            return {
                imageBottom: imageRect.bottom,
                imageRight: imageRect.right,
                cardBottom: cardRect.bottom,
                cardRight: cardRect.right,
                followerTop: followerRect.top
            }
        }, card)

        // The image must not paint past its own card box.
        expect(geometry.imageBottom).toBeLessThanOrEqual(geometry.cardBottom + 0.5)
        expect(geometry.imageRight).toBeLessThanOrEqual(geometry.cardRight + 0.5)
        // Following content must start below the card, never on top of it.
        expect(geometry.followerTop).toBeGreaterThanOrEqual(geometry.cardBottom - 0.5)
    })
})
