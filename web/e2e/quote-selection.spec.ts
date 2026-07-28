import { expect, test } from '@playwright/test'

const FIXTURE = '/e2e-fixtures/quote-selection-e2e.html'

/**
 * 用真实指针事件拖拽选中一个元素的全部文本。
 *
 * 刻意不用 element.click() / JS 构造 Range：那样不产生真实的
 * mousedown/mouseup 序列，也不会移动指针，会掩盖"选区失效导致反馈提前
 * 消失"这一类缺陷——原型阶段的一个真实 bug 正是这样被漏掉的。
 */
async function dragSelect(page: import('@playwright/test').Page, selector: string) {
    const box = await page.locator(selector).boundingBox()
    if (!box) throw new Error(`no box for ${selector}`)
    await page.mouse.move(box.x + 4, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 12 })
    await page.mouse.up()
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear())
})

test('selecting text reveals the quote bubble', async ({ page }) => {
    await page.goto(FIXTURE)
    await expect(page.getByTestId('quote-selection-popover')).toBeHidden()
    await dragSelect(page, '#msg-1 p')
    await expect(page.getByTestId('quote-selection-popover')).toBeVisible()
})

test('opening the bubble does not clear the text selection', async ({ page }) => {
    // 头号风险的回归测试：Radix Popover 的 autofocus 会清除选区，
    // 一旦回归，引用拿到的是空文本，功能静默失效。
    await page.goto(FIXTURE)
    await dragSelect(page, '#msg-1 p')
    await expect(page.getByTestId('quote-selection-popover')).toBeVisible()
    const length = await page.evaluate(() => window.getSelection()?.toString().length ?? 0)
    expect(length).toBeGreaterThan(0)
})

test('quoting creates a chip and serializes into the payload', async ({ page }) => {
    await page.goto(FIXTURE)
    await dragSelect(page, '#msg-1 p')
    await page.getByTestId('quote-button').click()
    await expect(page.getByTestId('quote-chip')).toHaveCount(1)
    await page.getByTestId('body-input').fill('why?')
    const serialized = await page.getByTestId('serialized').innerText()
    expect(serialized).toContain('> The converter passes')
    expect(serialized).toContain('why?')
    expect(serialized).not.toContain('[1]')
})

test('a second quote retroactively numbers the first', async ({ page }) => {
    await page.goto(FIXTURE)
    await dragSelect(page, '#msg-1 p')
    await page.getByTestId('quote-button').click()
    await dragSelect(page, '#msg-2 p')
    await page.getByTestId('quote-button').click()
    await expect(page.getByTestId('quote-chip')).toHaveCount(2)
    const serialized = await page.getByTestId('serialized').innerText()
    expect(serialized).toContain('**[1]**')
    expect(serialized).toContain('**[2]**')
})

test('removing a quote renumbers the rest', async ({ page }) => {
    await page.goto(FIXTURE)
    for (const selector of ['#msg-1 p', '#msg-2 p']) {
        await dragSelect(page, selector)
        await page.getByTestId('quote-button').click()
    }
    await page.getByTestId('quote-chip').first().hover()
    await page.getByTestId('quote-chip-remove').first().click()
    await expect(page.getByTestId('quote-chip')).toHaveCount(1)
    const serialized = await page.getByTestId('serialized').innerText()
    expect(serialized).not.toContain('**[2]**')
})

test('copy feedback survives the selection being dismissed', async ({ page }) => {
    // 原型阶段的真实缺陷：反馈寿命被绑在"选区仍存在"上，真人点完复制
    // 移开鼠标，选区失效，确认提示瞬间消失。
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto(FIXTURE)
    await dragSelect(page, '#msg-1 p')
    await page.getByTestId('quote-copy-button').click()
    await page.mouse.move(700, 700, { steps: 8 })
    await page.mouse.click(700, 700)
    await expect(page.getByTestId('quote-copy-button')).toContainText(/Copied|已复制/)
})

test('quoting highlights the source text via the Custom Highlight API', async ({ page }) => {
    // 高亮走 CSS.highlights 而不是往消息 DOM 里插 <mark>：消息由 React 渲染
    // markdown，插入的节点会在下次 re-render 时被抹掉。所以断言注册表而非 DOM。
    await page.goto(FIXTURE)
    const supported = await page.evaluate(() => typeof CSS !== 'undefined' && 'highlights' in CSS)
    test.skip(!supported, 'browser lacks CSS Custom Highlight API')

    await expect.poll(() => page.evaluate(() => CSS.highlights.has('hapi-quote'))).toBe(false)
    await dragSelect(page, '#msg-1 p')
    await page.getByTestId('quote-button').click()
    await expect(page.getByTestId('quote-chip')).toHaveCount(1)

    await expect.poll(() => page.evaluate(() => CSS.highlights.get('hapi-quote')?.size ?? 0)).toBe(1)
    // 高亮不能是插进 DOM 的元素
    expect(await page.locator('#msg-1 mark').count()).toBe(0)
})

test('two quotes render numbered markers pinned to the source', async ({ page }) => {
    await page.goto(FIXTURE)
    await dragSelect(page, '#msg-1 p')
    await page.getByTestId('quote-button').click()
    // 单条引用不编号，所以此时不该有角标
    await expect(page.getByTestId('quote-marker')).toHaveCount(0)

    await dragSelect(page, '#msg-2 p')
    await page.getByTestId('quote-button').click()
    await expect(page.getByTestId('quote-marker')).toHaveCount(2)
    await expect(page.getByTestId('quote-marker').first()).toHaveText('1')
    await expect(page.getByTestId('quote-marker').nth(1)).toHaveText('2')

    // 角标是浮层，不能参与文本流——否则中文正文会把它挤到下一行独占一行
    const inFlow = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="quote-marker"]')]
            .some((el) => getComputedStyle(el).position !== 'absolute'))
    expect(inFlow).toBe(false)
})
