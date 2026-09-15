import { expect, test } from '@playwright/test'

test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
})

async function scrollToEnd(page: import('@playwright/test').Page, testId: string) {
    const region = page.getByTestId(testId)
    await region.hover()
    await page.mouse.wheel(320, 0)
    await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
}

test.describe('scrollable detail and file titles', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/e2e-fixtures/scrollable-title-fixture.html')
    })

    test('detects overflow and scrolls the title surface horizontally on mobile', async ({ page }) => {
        const sessionTitle = page.getByTestId('session-title')
        await expect(sessionTitle).toHaveAttribute('role', 'region')
        await expect.poll(async () => sessionTitle.evaluate((element) => (
            element.scrollWidth > element.clientWidth
        ))).toBe(true)

        const dimensions = await sessionTitle.evaluate((element) => ({
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
        }))
        expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth)
        const scrollbar = await sessionTitle.evaluate((element) => {
            const style = getComputedStyle(element, '::-webkit-scrollbar')
            return {
                display: style.display,
                width: style.width,
                height: style.height,
            }
        })
        expect(scrollbar).toEqual({ display: 'none', width: '0px', height: '0px' })

        await scrollToEnd(page, 'session-title')
        await expect(page.getByTestId('session-title')).toHaveClass(/overflow-x-auto/)
        await expect(page.getByTestId('file-title')).toHaveClass(/overflow-x-auto/)
        await expect(page.getByTestId('metadata')).toHaveAttribute('role', 'region')
        await expect(page.getByTestId('metadata')).toContainText('codex')
        await expect(page.getByTestId('metadata')).toContainText('machine: NUC')
        await expect(page.getByTestId('metadata')).toContainText('model: gpt-5.4')
        await expect(page.getByTestId('metadata')).toContainText('reasoning xhigh')
        await expect(page.getByTestId('metadata')).toContainText('fast')
        await expect(page.getByTestId('metadata')).toContainText('feature/mobile-title-scroll')
        await expect(page.getByTestId('session-title-end-fade')).toHaveCount(0)
        await expect(page.getByTestId('session-title-start-fade')).toBeVisible()
        await expect(page.getByRole('button')).toHaveCount(0)
    })
})
