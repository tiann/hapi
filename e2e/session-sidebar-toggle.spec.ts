import { expect, test, type Page } from '@playwright/test'

const splitViewport = { width: 1024, height: 768 }

async function assertTouchToggle(page: Page) {
    await page.goto('/e2e-fixtures/session-sidebar-toggle-fixture.html')

    const modes = await page.evaluate(() => ({
        width: window.innerWidth,
        hasTouch: navigator.maxTouchPoints > 0,
        coarsePointer: window.matchMedia('(pointer: coarse)').matches,
        anyCoarsePointer: window.matchMedia('(any-pointer: coarse)').matches,
    }))
    expect(modes).toMatchObject({ width: 1024, hasTouch: true })
    expect(modes.coarsePointer || modes.anyCoarsePointer).toBe(true)

    const hideButton = page.getByRole('button', { name: 'Hide session list' })
    await expect(hideButton).toBeVisible()
    await expect(hideButton).toHaveCSS('pointer-events', 'auto')

    await hideButton.tap()
    await expect(page.getByRole('button', { name: 'Show session list' })).toBeVisible()

    await page.getByRole('button', { name: 'Show session list' }).tap()
    await expect(hideButton).toBeVisible()
}

test.describe('session sidebar toggle', () => {
    test('leaves the centre of the divider available for dragging', async ({ page }) => {
        await page.setViewportSize({ width: 1200, height: 800 })
        await page.goto('/e2e-fixtures/session-sidebar-toggle-fixture.html')
        const sidebar = page.getByRole('complementary')
        const previous = (await sidebar.boundingBox())!.width
        const divider = (await page.locator('.sidebar-resize-handle').boundingBox())!
        const x = divider.x + divider.width / 2
        const y = divider.y + divider.height / 2
        await page.mouse.move(x, y)
        await expect(page.getByRole('button', { name: 'Hide session list' })).toHaveCSS('opacity', '1')
        await page.mouse.down()
        await expect(page.locator('.sidebar-resize-handle')).toHaveAttribute('data-dragging', 'true')
        const hide = page.getByRole('button', { name: 'Hide session list' })
        await expect(hide).toBeDisabled()
        await page.keyboard.press('Tab')
        await expect(hide).not.toBeFocused()
        await page.keyboard.press('Enter')
        await page.keyboard.press('Space')
        await expect(sidebar).toBeVisible()
        await page.mouse.move(x + 60, y)
        await page.mouse.up()
        await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(previous + 60)
        await expect(hide).toBeEnabled()
    })

    test('transfers keyboard focus to the new toggle in both directions', async ({ page }) => {
        await page.setViewportSize({ width: 1200, height: 800 })
        await page.goto('/e2e-fixtures/session-sidebar-toggle-fixture.html')
        const hide = page.getByRole('button', { name: 'Hide session list' })
        const show = page.getByRole('button', { name: 'Show session list' })
        await page.keyboard.press('Tab')
        await expect(hide).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(show).toBeFocused()
        await page.keyboard.press('Space')
        await expect(hide).toBeFocused()
    })

    test.describe('coarse primary pointer', () => {
        test.use({
            viewport: splitViewport,
            isMobile: true,
            hasTouch: true,
        })

        test('keeps the hide action visible and tappable on split layouts', async ({ page }) => {
            await assertTouchToggle(page)
        })

        test('keeps the touch toggle outside the detail content', async ({ page }) => {
            await page.goto('/e2e-fixtures/session-sidebar-toggle-fixture.html')
            const hide = (await page.getByRole('button', { name: 'Hide session list' }).boundingBox())!
            const divider = (await page.locator('.sidebar-resize-handle').boundingBox())!
            const detail = (await page.getByRole('main').boundingBox())!
            expect(divider.width).toBe(4)
            expect(hide.x).toBeGreaterThanOrEqual(divider.x + divider.width)
            expect(hide.x + hide.width).toBeLessThanOrEqual(detail.x)
            await expect(page.getByTestId('terminal-first-column')).toBeVisible()
            await page.getByTestId('terminal-first-column').tap()
            await expect(page.getByRole('complementary')).toBeVisible()
            if (process.env.HAPI_REVIEW_SCREENSHOT_DIR) {
                await page.screenshot({ path: `${process.env.HAPI_REVIEW_SCREENSHOT_DIR}/sidebar-touch-terminal.png` })
            }
        })

        test('keeps the hybrid-pointer override after fine-pointer and before drag-state rules', async ({ page }) => {
            await page.goto('/e2e-fixtures/session-sidebar-toggle-fixture.html')

            const rule = await page.evaluate(() => {
                for (const sheet of Array.from(document.styleSheets)) {
                    let rules: CSSRuleList
                    try {
                        rules = sheet.cssRules
                    } catch {
                        continue
                    }

                    const finePointerIndex = Array.from(rules).findIndex((candidate) => (
                        candidate instanceof CSSMediaRule
                        && candidate.conditionText === '(hover: hover) and (pointer: fine)'
                        && Array.from(candidate.cssRules).some((inner) => (
                            inner instanceof CSSStyleRule
                            && inner.selectorText.includes('.sidebar-hide-button')
                        ))
                    ))
                    const anyPointerIndex = Array.from(rules).findIndex((candidate) => (
                        candidate instanceof CSSMediaRule
                        && candidate.conditionText === '(any-pointer: coarse)'
                    ))
                    const dragStateIndex = Array.from(rules).findIndex((candidate) => (
                        candidate instanceof CSSStyleRule
                        && candidate.selectorText.includes('[data-dragging] .sidebar-hide-button')
                    ))
                    const anyPointerRule = Array.from(rules).find((candidate) => (
                        candidate instanceof CSSMediaRule
                        && candidate.conditionText === '(any-pointer: coarse)'
                    ))
                    if (!(anyPointerRule instanceof CSSMediaRule)) {
                        continue
                    }

                    const hideRule = Array.from(anyPointerRule.cssRules).find((candidate) => (
                        candidate instanceof CSSStyleRule
                        && candidate.selectorText === '.sidebar-hide-button'
                    ))
                    if (!(hideRule instanceof CSSStyleRule)) {
                        continue
                    }

                    return {
                        finePointerIndex,
                        anyPointerIndex,
                        dragStateIndex,
                        opacity: hideRule.style.opacity,
                        pointerEvents: hideRule.style.pointerEvents,
                        transform: hideRule.style.transform,
                    }
                }
                return null
            })

            expect(rule).toEqual({
                finePointerIndex: expect.any(Number),
                anyPointerIndex: expect.any(Number),
                dragStateIndex: expect.any(Number),
                opacity: '1',
                pointerEvents: 'auto',
                transform: 'translateY(-50%) scale(1)',
            })
            expect(rule!.finePointerIndex).toBeGreaterThanOrEqual(0)
            expect(rule!.finePointerIndex).toBeLessThan(rule!.anyPointerIndex)
            expect(rule!.anyPointerIndex).toBeLessThan(rule!.dragStateIndex)
        })
    })
})
