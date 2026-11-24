import { expect, test } from '@playwright/test'

const fixtureUrl = '/e2e-fixtures/project-sort-fixture.html'

test.use({ viewport: { width: 480, height: 500 }, deviceScaleFactor: 1 })

test.describe('project sort modes', () => {
    test('uses upstream recent-activity order by default', async ({ page }, testInfo) => {
        await page.goto(fixtureUrl)

        const projectHeaders = page.locator('[title^="/projects/"]')
        await expect(projectHeaders).toHaveCount(2)
        await expect(projectHeaders.nth(0)).toHaveAttribute('title', '/projects/hapi')
        await expect(projectHeaders.nth(1)).toHaveAttribute('title', '/projects/mine')
        await page.screenshot({ path: testInfo.outputPath('project-order-recent.png'), fullPage: true })
        await page.evaluate(() => window.updateProjectSession('mine-session', { lastUserMessageAt: Date.now() + 60_000 }))
        await expect(projectHeaders.nth(0)).toHaveAttribute('title', '/projects/mine')
        await expect(projectHeaders.nth(1)).toHaveAttribute('title', '/projects/hapi')
    })

    test('orders projects by session count when selected', async ({ page }, testInfo) => {
        await page.goto(`${fixtureUrl}?mode=count`)

        const projectHeaders = page.locator('[title^="/projects/"]')
        await expect(projectHeaders).toHaveCount(2)
        await expect(projectHeaders.nth(0)).toHaveAttribute('title', '/projects/mine')
        await expect(projectHeaders.nth(1)).toHaveAttribute('title', '/projects/hapi')
        await page.screenshot({ path: testInfo.outputPath('project-order-count.png'), fullPage: true })
        await page.evaluate(() => window.updateProjectSession('hapi-session', { lastUserMessageAt: Date.now() + 60_000 }))
        await expect(projectHeaders.nth(0)).toHaveAttribute('title', '/projects/mine')
        await expect(projectHeaders.nth(1)).toHaveAttribute('title', '/projects/hapi')
    })

    test('uses total project counts across combined active and archived groups', async ({ page }) => {
        await page.goto(`${fixtureUrl}?mode=combined-count`)

        const projectHeaders = page.locator('[title^="/projects/"]')
        await expect(projectHeaders).toHaveCount(3)
        await expect(projectHeaders.nth(0)).toHaveAttribute('title', '/projects/mine')
        await expect(projectHeaders.nth(1)).toHaveAttribute('title', '/projects/hapi')
        await expect(projectHeaders.nth(2)).toHaveAttribute('title', '/projects/mine')
    })
})


test('an older tab keeps another tab’s first-seen rank for tied projects', async ({ page, context }) => {
    const olderTab = await context.newPage()
    await olderTab.goto(`${fixtureUrl}?crossTab=1`)
    await olderTab.waitForFunction(() => typeof window.showProjectSortProjects === 'function')
    await page.goto(`${fixtureUrl}?crossTab=1`)
    await page.waitForFunction(() => typeof window.showProjectSortProjects === 'function')
    await page.evaluate(() => window.showProjectSortProjects(['first']))
    await expect(page.locator('[title="/projects/first"]')).toBeVisible()
    await olderTab.evaluate(() => window.showProjectSortProjects(['second', 'first']))
    const headers = olderTab.locator('[title^="/projects/"]')
    await expect(headers).toHaveCount(2)
    await expect(headers.nth(0)).toHaveAttribute('title', '/projects/first')
    await expect(headers.nth(1)).toHaveAttribute('title', '/projects/second')
    const screenshotPath = process.env.HAPI_PROJECT_RANK_SCREENSHOT
    if (screenshotPath) await olderTab.screenshot({ path: screenshotPath })
})
