import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

test.use({ viewport: { width: 412, height: 915 }, hasTouch: true })
test.setTimeout(60_000)

const fixture = '/e2e-fixtures/directory-input-fixture.html'
const windowsPath = 'C:\\Users\\Example\\Downloads\\Agent\\Hapi\\worktrees\\directory-scroll-project'
const posixPath = '/home/example/projects/hapi/worktrees/mobile-directory-scroll-project'

async function atEnd(input: Locator) {
    await expect.poll(() => input.evaluate((el: HTMLInputElement) => (
        el.scrollWidth - el.clientWidth - el.scrollLeft
    ))).toBeLessThanOrEqual(2)
}

async function swipe(page: Page, input: Locator, dx: number, dy = 0) {
    const box = (await input.boundingBox())!
    const startX = dx > 0 ? box.x + 24 : box.x + box.width - 24
    const startY = box.y + box.height / 2
    const session = await page.context().newCDPSession(page)
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y: startY }] })
    for (let step = 1; step <= 8; step++) {
        await session.send('Input.dispatchTouchEvent', {
            type: 'touchMove', touchPoints: [{ x: startX + dx * step / 8, y: startY + dy * step / 8 }],
        })
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await session.detach()
}

test('initial long paths show the tail without focusing or changing the value', async ({ page }) => {
    for (const path of [windowsPath, posixPath, 'C:\\项目\\长目录名称\\移动端测试\\'.repeat(4) + '最终目录']) {
        await page.goto(`${fixture}?path=${encodeURIComponent(path)}`)
        const input = page.getByRole('textbox')
        await expect(input).toHaveValue(path)
        expect(await input.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
        if (path === windowsPath && process.env.HAPI_DIRECTORY_SCREENSHOTS) {
            await mkdir(process.env.HAPI_DIRECTORY_SCREENSHOTS, { recursive: true })
            await page.screenshot({ path: join(process.env.HAPI_DIRECTORY_SCREENSHOTS, 'initial-directory.png') })
        }
        await atEnd(input)
        await expect(input).not.toBeFocused()
    }
})

test('manual inspection survives rerenders and taps still enter normal editing', async ({ page }) => {
    await page.goto(fixture)
    const input = page.getByRole('textbox')
    await input.evaluate(el => { el.scrollLeft = 30 })
    await page.getByRole('button', { name: /Unrelated update/ }).click()
    expect(await input.evaluate(el => el.scrollLeft)).toBe(30)
    await input.tap()
    await expect(input).toBeFocused()
    await input.press('Home')
    await input.press('ArrowRight')
    await input.press('ArrowRight')
    await input.press('Shift+ArrowRight')
    expect(await input.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart!, el.selectionEnd!))).toBe('\\')
    await input.press('ArrowLeft')
    await input.pressSequentially('edited-')
    await expect(input).toHaveValue('C:edited-' + windowsPath.slice(2))
    expect(await input.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(9)
    expect(await input.evaluate(el => el.scrollLeft)).toBeLessThan(40)
    await input.press('ControlOrMeta+a')
    expect(await input.evaluate((el: HTMLInputElement) => el.selectionEnd! - el.selectionStart!)).toBe((await input.inputValue()).length)
})

test('leaving the editor reveals the tail and keeps subsequent manual inspection', async ({ page }) => {
    await page.goto(fixture)
    const input = page.getByRole('textbox')
    await input.tap()
    await input.press('End')
    // Reproduce the reset observed on Via/WebView after focus is lost.
    await input.evaluate(el => el.addEventListener('blur', () => { el.scrollLeft = 0 }, { once: true }))
    await page.getByText('HAPI · New Session · Directory fixture', { exact: true }).click()
    await expect(input).not.toBeFocused()
    await atEnd(input)
    await expect(input).toHaveValue(windowsPath)
    await input.evaluate(el => { el.scrollLeft = 35 })
    await page.getByRole('button', { name: /Unrelated update/ }).click()
    expect(await input.evaluate(el => el.scrollLeft)).toBe(35)
    await input.tap()
    await input.press('Home')
    await input.pressSequentially('edited-')
    await expect(input).toHaveValue('edited-' + windowsPath)
    expect(await input.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(7)
    await page.getByText('HAPI · New Session · Directory fixture', { exact: true }).click()
    await atEnd(input)
})

test('empty and disabled fields retain native behavior without changing the page width', async ({ page }) => {
    await page.goto(fixture)
    const input = page.getByRole('textbox')
    await page.getByRole('button', { name: 'Toggle disabled' }).click()
    await expect(input).toBeDisabled()
    await page.getByRole('button', { name: 'Toggle disabled' }).click()
    await page.getByRole('button', { name: 'Clear', exact: true }).click()
    await expect(input).toHaveValue('')
    expect(await input.evaluate(el => el.scrollLeft)).toBe(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(412)
    await input.tap()
    await expect(input).toBeFocused()
    await input.fill('/tmp')
    await expect(input).toHaveValue('/tmp')
})

test('vertical swipes over the unfocused input still scroll the form', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Trusted touch events use Chromium CDP.')
    await page.goto(fixture)
    const input = page.getByRole('textbox')
    const before = await input.evaluate(el => el.scrollLeft)
    await swipe(page, input, 0, -80)
    await expect.poll(() => page.locator('main').evaluate(el => el.scrollTop)).toBeGreaterThan(20)
    expect(await input.evaluate(el => el.scrollLeft)).toBe(before)
    await expect(input).not.toBeFocused()
})

test('Browse and recent selections show tails while preserving full values', async ({ page }) => {
    await page.goto(fixture)
    const input = page.getByRole('textbox')
    await page.getByRole('button', { name: 'Browse', exact: true }).click()
    await expect(input).toHaveValue(posixPath)
    await atEnd(input)
    await page.getByRole('button', { name: windowsPath, exact: true }).click()
    await expect(input).toHaveValue(windowsPath)
    await atEnd(input)
    await input.evaluate(el => { el.scrollLeft = 15 })
    await page.getByRole('button', { name: windowsPath, exact: true }).click()
    await atEnd(input)
    await page.getByRole('button', { name: '/tmp', exact: true }).click()
    await expect(input).toHaveValue('/tmp')
    expect(await input.evaluate(el => el.scrollLeft)).toBe(0)
})

test('unfocused touch swipes inspect both directions without opening the editor', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Trusted drag touch events use Chromium CDP.')
    await page.goto(fixture)
    const input = page.getByRole('textbox')
    await input.evaluate(el => { el.scrollLeft = el.scrollWidth })
    const tailOffset = await input.evaluate(el => el.scrollLeft)
    await swipe(page, input, 180)
    await expect.poll(() => input.evaluate(el => el.scrollLeft)).toBeLessThan(tailOffset - 100)
    await expect(input).not.toBeFocused()
    const offset = await input.evaluate(el => el.scrollLeft)
    await swipe(page, input, -140)
    await expect.poll(() => input.evaluate(el => el.scrollLeft)).toBeGreaterThan(offset + 80)
    await expect(input).not.toBeFocused()
    await expect(input).toHaveValue(windowsPath)
})
