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


test('ranks action-only projects by relevance when count sorting is active', async ({ page }) => {
    await page.goto(`${fixtureUrl}?mode=action-search`)
    await page.getByRole('button', { name: /Search sessions/ }).click()
    await page.getByPlaceholder('Search title/path/Agent/machine/ID…').fill('home')
    const headers = page.locator('[title^="/projects/"]')
    await expect(headers).toHaveCount(2)
    await expect(headers.nth(0)).toHaveAttribute('title', '/projects/strong')
    await expect(headers.nth(1)).toHaveAttribute('title', '/projects/home-weak')
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/project-sort-action-search.png`, fullPage: true })
})


test('uses count order for action-only projects during Exclude search', async ({ page }) => {
    await page.goto(`${fixtureUrl}?mode=action-search`)
    await page.getByRole('button', { name: /Search sessions/ }).click()
    await page.getByRole('button', { name: 'Search scope' }).click()
    await page.getByRole('button', { name: 'Exclude' }).click()
    await page.getByPlaceholder('Search title/path/Agent/machine/ID…').fill('no-such-session')
    const headers = page.locator('[title^="/projects/"]')
    await expect(headers).toHaveCount(2)
    await expect(headers.nth(0)).toHaveAttribute('title', '/projects/home-weak')
    await expect(headers.nth(1)).toHaveAttribute('title', '/projects/strong')
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/project-sort-exclude-count.png`, fullPage: true })
})


test('keeps Date created order on action-only projects during Exclude search', async ({ page }) => {
    await page.goto(`${fixtureUrl}?mode=action-search-created`)
    await page.getByRole('button', { name: /Search sessions/ }).click()
    await page.getByRole('button', { name: 'Search scope' }).click()
    await page.getByRole('button', { name: 'Exclude' }).click()
    await page.getByPlaceholder('Search title/path/Agent/machine/ID…').fill('no-such-session')
    const headers = page.locator('[title^="/projects/"]')
    await expect(headers).toHaveCount(2)
    await expect(headers.first()).toHaveAttribute('title', '/projects/strong')
    await expect(headers.last()).toHaveAttribute('title', '/projects/home-weak')
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/project-sort-exclude-created.png`, fullPage: true })
})


test('Combined folds stay separate from Detailed project names', async ({ page }) => {
    await page.goto(`${fixtureUrl}?foldCollision=1`)
    const plain = page.locator('[title="/projects/app"]')
    const suffixed = page.locator('[title="/projects/app::active"]')
    await expect(plain).toHaveAttribute('aria-expanded', 'true')
    await plain.click()
    await expect(plain).toHaveAttribute('aria-expanded', 'false')
    const setLayout = (layout: 'combined' | 'detailed') => page.evaluate(mode => {
        const key = 'hapi-pin-in-progress-sessions-mode'
        window.localStorage.setItem(key, mode)
        window.dispatchEvent(new StorageEvent('storage', { key, newValue: mode }))
    }, layout)
    await setLayout('detailed')
    await expect(suffixed).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('button', { name: /Suffixed project session/ })).toBeInViewport()
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/project-sort-fold-collision.png`, fullPage: true })
    await setLayout('combined')
    await expect(plain).toHaveAttribute('aria-expanded', 'false')
})


test('keeps an archived session with a running job below the Combined divider', async ({ page }) => {
    await page.goto(`${fixtureUrl}?mode=combined-count&archivedJob=1`)
    const separator = page.getByRole('separator', { name: 'Archived project sessions' })
    const archivedRow = page.getByRole('button', { name: /Archived running job/ })
    await expect(separator).toBeVisible()
    await expect(archivedRow).toBeVisible()
    expect(await separator.evaluate((element, row) => element.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING, await archivedRow.elementHandle())).toBeTruthy()
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/project-sort-archived-running-job.png`, fullPage: true })
})


test('keeps a Combined export alive when its session disconnects', async ({ page }) => {
    await page.goto(`${fixtureUrl}?mode=combined-count&exportPending=1`)
    await page.getByRole('button', { name: /Mine task/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Export conversation' }).click()
    await page.getByRole('button', { name: 'Download', exact: true }).click()
    await page.evaluate(() => window.updateProjectSession('mine-session', { active: false }))
    await page.evaluate(() => window.finishProjectExport())
    await expect(page.getByRole('button', { name: 'Download anyway' })).toBeVisible()
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/project-sort-export-after-disconnect.png`, fullPage: true })
})


test('keeps an unsaved PR link when a Combined session disconnects', async ({ page }) => {
    await page.goto(`${fixtureUrl}?mode=combined-count&linkPr=1`)
    await page.getByRole('button', { name: /Mine task/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Link pull request…' }).click()
    await page.getByRole('textbox').fill('https://github.com/tiann/hapi/pull/2093')
    await page.evaluate(() => window.updateProjectSession('mine-session', { active: false }))
    await expect(page.getByRole('textbox')).toHaveValue('https://github.com/tiann/hapi/pull/2093')
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/project-sort-link-pr-after-disconnect.png`, fullPage: true })
})


test('reopening a PR link keeps pending state without the old request closing the new opening', async ({ page }) => {
    await page.goto(`${fixtureUrl}?mode=combined-count&linkPr=1`)
    const openLink = async () => {
        await page.getByRole('button', { name: /Mine task/ }).click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Link pull request…' }).click()
    }
    const dialog = page.getByRole('dialog')
    const input = dialog.getByRole('textbox')
    await openLink()
    await input.fill('https://github.com/tiann/hapi/pull/2093')
    await dialog.getByRole('button', { name: 'Link', exact: true }).click()
    await expect(input).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await openLink()
    await expect(input).toBeDisabled()
    await page.evaluate(() => window.finishProjectLink())
    await expect(input).toBeEnabled()
    const url = 'https://github.com/tiann/hapi/pull/1692'
    await input.fill(url)
    await expect(input).toHaveValue(url)
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/project-sort-reopened-pr-link-draft.png`, fullPage: true })
})


test('keeps archive cleanup visible through an inactive update', async ({ page }) => {
    await page.goto(`${fixtureUrl}?mode=combined-count&archivePending=1`)
    await page.getByRole('button', { name: /Mine task/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Archive', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Archive', exact: true }).click()
    await page.evaluate(() => window.updateProjectSession('mine-session', { active: false }))
    await expect(page.getByRole('dialog')).toContainText('Confirming archive and background cleanup')
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/project-sort-archive-cleanup.png`, fullPage: true })
    await page.evaluate(() => window.finishProjectArchive())
    await expect(page.getByRole('dialog')).toHaveCount(0)
})


test('moves a stale detached job below the Combined divider', async ({ page }) => {
    await page.goto(`${fixtureUrl}?mode=combined-count&staleJob=1`)
    const separator = page.getByRole('separator', { name: 'Archived project sessions' })
    const staleRow = page.getByRole('button', { name: /Stale running job/ })
    await expect(separator).toBeVisible()
    await expect(staleRow).toContainText('running')
    expect(await separator.evaluate((element, row) => element.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING, await staleRow.elementHandle())).toBeTruthy()
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/project-sort-stale-job.png`, fullPage: true })
})


test('keeps a fork preview open when its Combined source disconnects', async ({ page }) => {
    await page.goto(`${fixtureUrl}?mode=combined-count&forkPreview=1`)
    await page.getByRole('button', { name: /Mine task/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Fork session/ }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.evaluate(() => window.updateProjectSession('mine-session', { active: false }))
    await expect(page.getByRole('dialog')).toBeVisible()
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/project-sort-fork-preview-after-disconnect.png`, fullPage: true })
})


test('reopens a fork preview for the same row after cancel and after confirm', async ({ page }) => {
    await page.goto(`${fixtureUrl}?forkPreview=1`)
    const row = page.getByRole('button', { name: /Mine task/ })
    const dialog = page.getByRole('dialog')
    const openFork = async () => {
        await row.click({ button: 'right' })
        await page.getByRole('menuitem', { name: /Fork session/ }).click()
    }

    await openFork()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await openFork()
    await expect(dialog).toBeVisible()
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/project-sort-fork-preview-reopened.png`, fullPage: true })
    await dialog.getByTestId('fork-preview-confirm').click()
    await expect(dialog).toHaveCount(0)
    await openFork()
    await expect(dialog).toBeVisible()
})


test('keeps Archive all pending after the active project moves into history', async ({ page }) => {
    await page.goto(`${fixtureUrl}?mode=combined-count&archivePending=1`)
    const project = page.getByTitle('/projects/mine', { exact: true })
    await expect(project).toHaveCount(2)
    await project.first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Archive all', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(dialog.getByRole('button', { name: /^Archiving/ })).toBeDisabled()
    await page.evaluate(() => window.updateProjectSession('mine-session', { active: false }))
    await expect(project).toHaveCount(1)
    await expect(dialog.getByRole('button', { name: /^Archiving/ })).toBeDisabled()
    await expect(dialog).toContainText('Archive 1 sessions')
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/project-sort-archive-all-pending-after-disconnect.png`, fullPage: true })
    await page.evaluate(() => window.finishProjectArchive())
    await expect(dialog).toHaveCount(0)
})


test('reopening Archive all follows the pending batch for the same project', async ({ page }) => {
    await page.goto(`${fixtureUrl}?archivePending=1`)
    const openBatch = async () => {
        await page.getByTitle('/projects/mine', { exact: true }).click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Archive all', exact: true }).click()
    }
    const dialog = page.getByRole('dialog')
    await openBatch()
    await dialog.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(dialog.getByRole('button', { name: /^Archiving/ })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await openBatch()
    await expect(dialog.getByRole('button', { name: /^Archiving/ })).toBeDisabled()
    await expect(dialog).toContainText('Archive 1 sessions')
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/project-sort-reopened-archive-all.png`, fullPage: true })
    await page.evaluate(() => window.finishProjectArchive())
    await expect(dialog.getByRole('button', { name: 'Archive', exact: true })).toBeEnabled()
})


test('reopened archive dialog follows the pending request for its row', async ({ page }) => {
    await page.goto(`${fixtureUrl}?mode=combined-count&archivePending=1`)
    const row = page.getByRole('button', { name: /Mine task/ })
    const dialog = page.getByRole('dialog')
    const openArchive = async () => {
        await row.click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Archive', exact: true }).click()
    }

    await openArchive()
    await dialog.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(dialog).toContainText('Archiving this session')
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
    await expect(dialog).toHaveCount(0)
    await openArchive()
    await expect(dialog).toContainText('Archiving this session')
    await expect(dialog.getByRole('button', { name: /^Archiving/ })).toBeDisabled()
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/project-sort-archive-reopened-pending.png`, fullPage: true })
    await page.evaluate(() => window.finishProjectArchive())
    await expect(dialog).toHaveCount(0)
})


test('keeps a Combined rename draft when its session disconnects', async ({ page }) => {
    await page.goto(`${fixtureUrl}?mode=combined-count`)
    await page.getByRole('button', { name: /Mine task/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    await page.getByRole('textbox').fill('Unsaved draft title')
    await page.evaluate(() => window.updateProjectSession('mine-session', { active: false }))
    await expect(page.getByRole('textbox')).toHaveValue('Unsaved draft title')
    await expect(page.locator('[role="separator"][aria-label="Archived project sessions"]')).toBeVisible()
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/project-sort-rename-draft-after-disconnect.png`, fullPage: true })
})


test('keeps a reopened Rename dialog busy until its previous save settles', async ({ page }) => {
    await page.goto(`${fixtureUrl}?mode=combined-count&renamePending=1`)
    const rename = async () => {
        await page.getByRole('button', { name: /Mine task/ }).click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Rename' }).click()
    }
    const dialog = page.getByRole('dialog', { name: 'Rename Session' })
    await rename()
    await dialog.getByRole('textbox').fill('First title')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await page.waitForFunction(() => typeof window.finishProjectRename === 'function')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await rename()
    await expect(dialog.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await page.screenshot({ path: `${screenshots}/project-sort-rename-pending.png`, fullPage: true })
    await page.evaluate(() => window.finishProjectRename())
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
})


test('localizes the Combined archived separator', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('hapi-lang', 'ja'))
    await page.goto(`${fixtureUrl}?mode=combined-count`)
    await expect(page.getByRole('separator', { name: 'アーカイブ済みプロジェクトのセッション' })).toBeVisible()
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
