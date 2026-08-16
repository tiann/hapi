import { expect, test } from '@playwright/test'

const EXISTING_ASSISTANT_TEXT = 'This response was generated before the session was opened again.'
const EXISTING_REASONING_TEXT = 'This reasoning was generated before the session was opened again.'
const NEW_ASSISTANT_TEXT = 'This is newly generated output and it must still appear with the typewriter animation enabled.'

test('keeps the typewriter for newly generated assistant output', async ({ page }) => {
    await page.goto('/e2e-fixtures/typing-replay-fixture.html?stream-new=1')

    await expect(page.getByTestId('assistant-message')).toHaveCount(1)
    await expect(page.getByTestId('assistant-text')).toHaveText(EXISTING_ASSISTANT_TEXT)

    await page.getByTestId('start-running').click()

    await expect(page.getByTestId('assistant-message')).toHaveCount(2)
    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.newOutputFirstLayoutText))
        .toBe('')

    const newOutput = page.getByTestId('assistant-message').last().getByTestId('assistant-text')
    await expect.poll(async () => await newOutput.textContent())
        .toBe(NEW_ASSISTANT_TEXT)
})

test('keeps the typewriter for the first response in an empty active thread', async ({ page }) => {
    await page.goto('/e2e-fixtures/typing-replay-fixture.html?empty-thread=1&active-turn=1&stream-new=1')

    await expect(page.getByTestId('assistant-message')).toHaveCount(0)
    await page.getByTestId('start-running').click()

    await expect(page.getByTestId('assistant-message')).toHaveCount(1)
    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.newOutputFirstLayoutText))
        .toBe('')

    await expect(page.getByTestId('assistant-message').last().getByTestId('assistant-text'))
        .toHaveText(NEW_ASSISTANT_TEXT)
})

test('keeps the typewriter for the first response after a running user-only turn', async ({ page }) => {
    await page.goto('/e2e-fixtures/typing-replay-fixture.html?running=1&user-only=1&stream-new=1')

    await page.getByTestId('start-running').click()

    await expect(page.getByTestId('assistant-message')).toHaveCount(1)
    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.newOutputFirstLayoutText))
        .toBe('')

    await expect(page.getByTestId('assistant-message').last().getByTestId('assistant-text'))
        .toHaveText(NEW_ASSISTANT_TEXT)
})

// Regression: a resumed session may expose an already-materialized assistant
// part as the currently running part. The first paint must show the full text,
// rather than replaying assistant-ui's typewriter animation from empty.
test('does not replay existing assistant text when opening a running session', async ({ page }) => {
    await page.goto('/e2e-fixtures/typing-replay-fixture.html?running=1')

    await expect(page.getByTestId('assistant-message')).toBeVisible()
    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.firstLayoutText ?? ''))
        .toBe(EXISTING_ASSISTANT_TEXT)

    await expect(page.getByTestId('assistant-text')).toHaveText(EXISTING_ASSISTANT_TEXT)
})

test('does not treat prepended older history as new assistant output', async ({ page }) => {
    await page.goto('/e2e-fixtures/typing-replay-fixture.html?running=1&prepend-history=1')

    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.statusTypes?.at(-1) ?? ''))
        .toBe('complete')

    await page.getByTestId('prepend-history').click()

    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.statusTypes?.at(-1) ?? ''))
        .toBe('complete')
    await expect(page.getByTestId('assistant-message').last().getByTestId('assistant-text'))
        .toHaveText(EXISTING_ASSISTANT_TEXT)
})

test('does not release the handoff when history pagination trims the old tail', async ({ page }) => {
    await page.goto('/e2e-fixtures/typing-replay-fixture.html?running=1&history-window=1')

    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.statusTypes?.at(-1) ?? ''))
        .toBe('complete')

    await page.getByTestId('prepend-history-window').click()

    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.statusTypes?.at(-1) ?? ''))
        .toBe('complete')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Older history response 799.')
})

test('does not replay when returning to tail after bounded history pagination', async ({ page }) => {
    await page.goto('/e2e-fixtures/typing-replay-fixture.html?running=1&history-window=1&return-to-tail=1')

    await page.getByTestId('prepend-history-window').click()
    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.statusTypes?.at(-1) ?? ''))
        .toBe('complete')

    await page.getByTestId('return-to-tail').click()

    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.statusTypes?.at(-1) ?? ''))
        .toBe('complete')
    await expect(page.getByTestId('assistant-text').last()).toHaveText(EXISTING_ASSISTANT_TEXT)
})

test('does not replay a hydrated assistant part when a running session mounts before history', async ({ page }) => {
    await page.goto('/e2e-fixtures/typing-replay-fixture.html?running=1&hydrate=1')

    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.firstLayoutText ?? ''))
        .toBe(EXISTING_ASSISTANT_TEXT)
    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.statusTypes?.at(-1) ?? ''))
        .toBe('complete')
    await expect(page.getByTestId('assistant-text')).toHaveText(EXISTING_ASSISTANT_TEXT)
})

test('does not replay active-turn output when a running session hydrates history', async ({ page }) => {
    await page.goto('/e2e-fixtures/typing-replay-fixture.html?running=1&hydrate=1&active-turn=1&hydrate-active-output=1')

    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.firstLayoutText ?? ''))
        .toBe(EXISTING_ASSISTANT_TEXT)
    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.statusTypes?.at(-1) ?? ''))
        .toBe('complete')
    await expect(page.getByTestId('assistant-text')).toHaveText(EXISTING_ASSISTANT_TEXT)
})

test('does not replay history after a completed session starts running before its history arrives', async ({ page }) => {
    await page.goto('/e2e-fixtures/typing-replay-fixture.html?hydrate-after-start=1')

    await page.getByTestId('start-running').click()
    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.firstLayoutText ?? ''))
        .toBe(EXISTING_ASSISTANT_TEXT)
    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.statusTypes?.at(-1) ?? ''))
        .toBe('complete')
    await expect(page.getByTestId('assistant-text')).toHaveText(EXISTING_ASSISTANT_TEXT)
})

// Regression: sending a new message can briefly mark the previous assistant
// part as running before the new user part is committed. That status change
// must not restart the already-complete response from an empty string.
test('does not replay the previous response during a new send', async ({ page }) => {
    await page.goto('/e2e-fixtures/typing-replay-fixture.html')

    await expect(page.getByTestId('assistant-text')).toHaveText(EXISTING_ASSISTANT_TEXT)
    await page.getByTestId('start-running').click()

    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.statusTypes?.at(-1) ?? ''))
        .toBe('complete')
    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.reasoningGroupStatusTypes ?? []))
        .not.toContain('running')
    await expect(page.getByTestId('assistant-text')).toHaveText(EXISTING_ASSISTANT_TEXT)
})

test('keeps a live response running after history pagination', async ({ page }) => {
    await page.goto('/e2e-fixtures/typing-replay-fixture.html?stream-new=1&history-after-output=1')

    await page.getByTestId('start-running').click()
    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.statusTypes?.at(-1) ?? ''))
        .toBe('running')

    await page.getByTestId('history-after-output').click()

    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.statusTypes?.at(-1) ?? ''))
        .toBe('running')
})

test('does not replay existing reasoning when opening a running session', async ({ page }) => {
    await page.goto('/e2e-fixtures/typing-replay-fixture.html?running=1&reasoning=1')

    await expect(page.getByTestId('reasoning-text')).toBeVisible()
    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.reasoningFirstLayoutText ?? ''))
        .toBe(EXISTING_REASONING_TEXT)

    await expect(page.getByTestId('reasoning-text')).toHaveText(EXISTING_REASONING_TEXT)
})

test('does not replay hydrated reasoning when a running session mounts before history', async ({ page }) => {
    await page.goto('/e2e-fixtures/typing-replay-fixture.html?running=1&reasoning=1&hydrate=1')

    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.reasoningFirstLayoutText ?? ''))
        .toBe(EXISTING_REASONING_TEXT)
    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.reasoningStatusTypes?.at(-1) ?? ''))
        .toBe('complete')
    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.reasoningGroupStatusTypes ?? []))
        .not.toContain('running')
    await expect(page.getByTestId('reasoning-text')).toHaveText(EXISTING_REASONING_TEXT)
})

test('does not replay history reasoning after a completed session starts running before history arrives', async ({ page }) => {
    await page.goto('/e2e-fixtures/typing-replay-fixture.html?reasoning=1&hydrate-after-start=1')

    await page.getByTestId('start-running').click()
    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.reasoningFirstLayoutText ?? ''))
        .toBe(EXISTING_REASONING_TEXT)
    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.reasoningStatusTypes?.at(-1) ?? ''))
        .toBe('complete')
    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.reasoningGroupStatusTypes ?? []))
        .not.toContain('running')
    await expect(page.getByTestId('reasoning-text')).toHaveText(EXISTING_REASONING_TEXT)
})

test('does not replay reasoning when a new send briefly marks it running', async ({ page }) => {
    await page.goto('/e2e-fixtures/typing-replay-fixture.html?reasoning=1')

    await expect(page.getByTestId('reasoning-text')).toHaveText(EXISTING_REASONING_TEXT)
    await page.getByTestId('start-running').click()

    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.reasoningStatusTypes?.at(-1) ?? ''))
        .toBe('complete')
    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.reasoningGroupStatusTypes ?? []))
        .not.toContain('running')
    await expect(page.getByTestId('reasoning-text')).toHaveText(EXISTING_REASONING_TEXT)
})

test('does not mark the previous response running before active-turn output exists', async ({ page }) => {
    await page.goto('/e2e-fixtures/typing-replay-fixture.html?active-turn=1')

    await expect(page.getByTestId('assistant-text')).toHaveText(EXISTING_ASSISTANT_TEXT)
    await page.getByTestId('start-running').click()

    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.statusTypes?.at(-1) ?? ''))
        .toBe('complete')
    await expect(page.getByTestId('assistant-text')).toHaveText(EXISTING_ASSISTANT_TEXT)
})

test('does not replay a response when switching into another running session', async ({ page }) => {
    await page.goto('/e2e-fixtures/typing-replay-fixture.html?switch-session=1')

    await expect(page.getByTestId('assistant-text')).toHaveText(EXISTING_ASSISTANT_TEXT)
    await page.getByTestId('switch-session').click()

    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.statusTypes?.at(-1) ?? ''))
        .toBe('complete')
    await expect.poll(async () => await page.evaluate(() => window.__typingReplayProbe?.reasoningGroupStatusTypes ?? []))
        .not.toContain('running')
    await expect(page.getByTestId('assistant-text')).toHaveText(EXISTING_ASSISTANT_TEXT)
})
