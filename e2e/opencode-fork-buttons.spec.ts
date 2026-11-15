import { expect, test } from '@playwright/test'

// OpenCode-flavor historical fork affordance: with conversationHistory
// points on every completed user turn, the Fork button must render on
// every historical user message that has a point — not only on the last
// message. The latest completed boundary keeps current-fork-only behavior.
// Holds in both `tail` and `history` view modes.
test('historical fork buttons render on every user message with a history point', async ({ page }) => {
    await page.goto('/e2e-fixtures/opencode-fork-buttons-fixture.html')
    const userMessages = page.locator('[data-hapi-message-role="user"]')
    await expect(userMessages).toHaveCount(12, { timeout: 15_000 })

    const expectForksOnEveryUserCard = async () => {
        const count = await userMessages.count()
        expect(count).toBe(12)
        for (let index = 0; index < count; index += 1) {
            const card = userMessages.nth(index)
            await expect(card.getByTestId('message-fork')).toHaveCount(1)
            await expect(card.getByTestId('message-fork')).toBeVisible()
        }
    }

    // Tail mode: every pointed user card renders its historical Fork button.
    await expectForksOnEveryUserCard()

    // The latest completed boundary keeps only-current behavior: it is an
    // assistant card (not a user card) and carries a single Fork button
    // that forks the current conversation rather than a historical point.
    const boundaryId = await page.evaluate(() => window.__probe.boundaryId)
    expect(typeof boundaryId).toBe('string')
    expect(boundaryId).toMatch(/^agent-text:/)
    const boundaryForkCount = await page.evaluate((id) => {
        const anchor = document.getElementById(`hapi-message-${id}`)
        return anchor?.querySelectorAll('[data-testid="message-fork"]').length ?? -1
    }, boundaryId)
    expect(boundaryForkCount).toBe(1)

    // History mode: scroll away from the bottom, then the remembered tail
    // boundary still applies and every pointed user card keeps its button.
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    const overflow = await page.evaluate(() => {
        const el = document.querySelector('.app-scroll-y') as HTMLElement
        return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: el.scrollTop }
    })
    expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight)
    expect(overflow.scrollTop).toBeGreaterThan(0)
    // Scroll away from the bottom with a real wheel gesture: the smart-scroll
    // controller only honors explicit upward intent (wheel/pointer) as a mode
    // switch, and programmatic scrollTop can be swallowed by initial settling.
    await viewport.hover()
    for (let i = 0; i < 12; i += 1) {
        await page.mouse.wheel(0, -800)
        await page.waitForTimeout(100)
    }
    await expect.poll(async () => await page.evaluate(() => window.__probe.viewMode)).toBe('history')
    await expectForksOnEveryUserCard()
    const historyBoundaryId = await page.evaluate(() => window.__probe.boundaryId)
    expect(historyBoundaryId).toBe(boundaryId)
})

test('historical assistant replies fork at the next user boundary; latest forks current', async ({ page }, testInfo) => {
    await page.goto('/e2e-fixtures/opencode-fork-buttons-fixture.html')
    const replies = page.locator('[data-hapi-message-role="assistant"]')
    await expect(replies).toHaveCount(12)
    for (let i = 0; i < 12; i += 1) {
        await expect(replies.nth(i).getByTestId('message-fork')).toHaveCount(1)
    }
    await page.waitForTimeout(2000)
    await replies.nth(2).hover()
    await replies.nth(2).getByTestId('message-fork').click()
    await page.getByRole('dialog').getByRole('button', { name: 'Fork', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__probe.forkCalls)).toEqual(['u-local-4'])
    await replies.nth(2).hover()
    await page.screenshot({ path: testInfo.outputPath('historical-fork-fixed.png') })
    await replies.last().hover()
    await replies.last().getByTestId('message-fork').click()
    await page.getByRole('dialog').getByRole('button', { name: 'Fork', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__probe.forkCalls)).toEqual(['u-local-4', undefined])
})

test('does not offer an assistant fork across a missing native boundary', async ({ page }) => {
    await page.goto('/e2e-fixtures/opencode-fork-buttons-fixture.html?missingPoint=1')
    const replies = page.locator('[data-hapi-message-role="assistant"]')
    await expect(replies).toHaveCount(12)
    await expect(replies.nth(2).getByTestId('message-fork')).toHaveCount(0)
    await expect(replies.nth(1).getByTestId('message-fork')).toHaveCount(1)
    await expect(replies.last().getByTestId('message-fork')).toHaveCount(1)
})

test('reasoning replies keep historical fork controls on the rendered card', async ({ page }) => {
    await page.goto('/e2e-fixtures/opencode-fork-buttons-fixture.html?reasoning=1')
    const replies = page.locator('[data-hapi-message-role="assistant"]')
    await expect(replies).toHaveCount(12)
    for (let i = 0; i < 12; i += 1) {
        await expect(replies.nth(i).getByTestId('message-fork')).toHaveCount(1)
    }
    await page.waitForTimeout(2000)
    await replies.nth(2).hover()
    await replies.nth(2).getByTestId('message-fork').click()
    await page.getByRole('dialog').getByRole('button', { name: 'Fork', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__probe.forkCalls)).toEqual(['u-local-4'])
})
