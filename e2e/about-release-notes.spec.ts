import { expect, test } from '@playwright/test'
import { APP_VERSION } from '../shared/src/buildInfo'
import { getVisibleReleaseNotes, RELEASE_NOTES } from '../web/src/lib/releaseNotes'

const fixture = '/e2e-fixtures/about-fixture.html'
const visibleReleaseNotes = getVisibleReleaseNotes(APP_VERSION, RELEASE_NOTES)
const latestRelease = visibleReleaseNotes[0]
const latestReleaseChanges = latestRelease.groups.flatMap((group) => group.changes)
const releaseKindLabels = {
    feature: { en: 'Added', 'zh-CN': '新增' },
    fix: { en: 'Fixed', 'zh-CN': '修复' },
    note: { en: 'Note', 'zh-CN': '说明' },
} as const

test('renders localized release announcements on the mobile About page', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(fixture)

    await expect(page.getByText("What's New")).toBeVisible()
    await expect(page.locator('details')).toHaveCount(visibleReleaseNotes.length)
    const releaseSummary = page.locator('details').first().locator('p').first()
    await expect(releaseSummary).toContainText(latestRelease.summary.en)
    await expect(releaseSummary.getByText('🌟', { exact: true })).toBeVisible()
    await expect(releaseSummary.getByText('⭐', { exact: true })).toBeHidden()
    await page.setViewportSize({ width: 1280, height: 844 })
    await expect(releaseSummary.getByText('🌟', { exact: true })).toBeHidden()
    await expect(releaseSummary.getByText('⭐', { exact: true })).toBeVisible()
    await expect(page.locator('details').first().getByText(releaseKindLabels[latestReleaseChanges[0].kind].en, { exact: true }).first()).toHaveClass(/sm:top-\[0\.5px\]/)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(releaseSummary.getByText('🌟', { exact: true })).toBeVisible()
    await expect(page.getByText(latestRelease.groups[0].changes[0].text.en)).toBeVisible()
    await expect(page.locator('details').first().getByText(releaseKindLabels[latestReleaseChanges[0].kind].en, { exact: true }).first()).toBeVisible()
    await expect(page.locator(`time[datetime="${latestRelease.date}"]`)).toBeVisible()
    await expect(page.getByRole('link', { name: `Open release page for v${latestRelease.version}` })).toHaveAttribute('href', latestRelease.url)
    await expect(page.getByText('View full release notes', { exact: true })).toHaveCount(0)

    const summary = page.locator('details').first().locator('summary')
    const summaryBox = await summary.boundingBox()
    if (!summaryBox) throw new Error('Could not measure the latest release summary')
    await page.mouse.click(summaryBox.x + summaryBox.width * 0.55, summaryBox.y + summaryBox.height / 2)
    await expect(page.context().pages()).toHaveLength(1)
    await expect(page).toHaveURL(/about-fixture\.html/)
    await expect(page.locator('details').first()).not.toHaveAttribute('open')

    await page.evaluate(() => window.localStorage.setItem('hapi-lang', 'zh-CN'))
    await page.reload()
    await expect(page.getByRole('heading', { name: '更新公告' })).toBeVisible()
    await expect(page.locator('details')).toHaveCount(visibleReleaseNotes.length)
    await expect(page.locator('details').first().locator('p').first()).toContainText(latestRelease.summary['zh-CN'])
    await expect(page.getByText(latestRelease.groups[0].changes[0].text['zh-CN'])).toBeVisible()
    await expect(page.locator('details').first().getByText(releaseKindLabels[latestReleaseChanges[0].kind]['zh-CN'], { exact: true }).first()).toBeVisible()
    await expect(page.getByRole('link', { name: `打开 v${latestRelease.version} 发行页` })).toBeVisible()
    await expect(page.getByText('查看完整发行说明', { exact: true })).toHaveCount(0)
})
