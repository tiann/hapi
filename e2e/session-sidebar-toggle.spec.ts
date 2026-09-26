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
    test.describe('coarse primary pointer', () => {
        test.use({
            viewport: splitViewport,
            isMobile: true,
            hasTouch: true,
        })

        test('keeps the hide action visible and tappable on split layouts', async ({ page }) => {
            await assertTouchToggle(page)
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
                transform: 'translate(-50%, -50%) scale(1)',
            })
            expect(rule!.finePointerIndex).toBeGreaterThanOrEqual(0)
            expect(rule!.finePointerIndex).toBeLessThan(rule!.anyPointerIndex)
            expect(rule!.anyPointerIndex).toBeLessThan(rule!.dragStateIndex)
        })
    })
})
