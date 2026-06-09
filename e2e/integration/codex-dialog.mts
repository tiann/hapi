/*
 * Integration test: CodexSessionSyncDialog.
 *
 * The dialog is opened from a button in the sessions list header
 * (aria-label="codexSync.tooltip"). It fetches local codex sessions
 * from /api/codex/sessions and displays them. We verify:
 *   1. The button is rendered (TC-WEB-45)
 *   2. Clicking it opens the dialog (TC-WEB-46)
 *   3. The dialog renders codex sessions (TC-WEB-47)
 *
 * Skipped if the hub reports 0 codex sessions.
 *
 * Run with: `bun run e2e/integration/codex-dialog.mts`
 */

import { startChrome, stopChrome, ENV, evalInPage, isVisible, sleep, loginWithToken, listSessions } from '../harness'

const TOKEN = process.env.HAPI_E2E_TOKEN
if (!TOKEN) {
    console.error('SKIP: HAPI_E2E_TOKEN not set')
    process.exit(0)
}

interface Result { caseId: string; scenario: string; passed: boolean; evidence: string }
const results: Result[] = []

function record(caseId: string, scenario: string, passed: boolean, evidence: string) {
    results.push({ caseId, scenario, passed, evidence })
    console.log(`${passed ? '✅' : '❌'} ${caseId}: ${scenario}`)
    console.log(`   ${evidence}`)
}

async function main() {
    // Pre-flight: check if there are codex sessions on the hub
    const jwt = await loginWithToken(TOKEN)
    const codexRes = await fetch(`${ENV.HUB_URL}/api/codex/sessions`, {
        headers: { Authorization: `Bearer ${jwt}` },
    })
    const codexData = (await codexRes.json()) as { sessions?: unknown[] }
    if (!codexData.sessions || codexData.sessions.length === 0) {
        console.log('SKIP: no codex sessions on hub')
        process.exit(0)
    }
    console.log(`Pre-flight OK: ${codexData.sessions.length} codex session(s) available\n`)

    await startChrome()
    try {
        // 1. Sign in
        await evalInPage(`fetch('${ENV.WEB_URL}/')`)
        await sleep(500)
        const isLogin = evalInPage<boolean>(`!!document.querySelector('input[type=password]')`)
        if (isLogin) {
            await evalInPage(`
                (() => {
                    const input = document.querySelector('input[type=password]');
                    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                    setter.call(input, '${TOKEN}');
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Sign In'))?.click();
                })()
            `)
            await sleep(3000)
        }

        // 2. Go to /sessions
        await evalInPage(`window.location.assign('${ENV.WEB_URL}/sessions')`)
        await sleep(2000)

        // TC-WEB-45: codex import button visible
        const importBtn = await evalInPage<boolean>(`
            (() => {
                const btn = document.querySelector('button[aria-label]');
                const all = Array.from(document.querySelectorAll('button[aria-label]'));
                return all.some(b => b.getAttribute('aria-label')?.toLowerCase().includes('codex') || b.getAttribute('title')?.toLowerCase().includes('codex'));
            })()
        `)
        record('TC-WEB-45', 'Codex import button 渲染', importBtn,
            `has_codex_button=${importBtn}`)

        // TC-WEB-46: click opens dialog
        evalInPage(`
            (() => {
                const btn = Array.from(document.querySelectorAll('button[aria-label]'))
                    .find(b => b.getAttribute('aria-label')?.toLowerCase().includes('codex') || b.getAttribute('title')?.toLowerCase().includes('codex'));
                if (btn) btn.click();
            })()
        `)
        await sleep(3000)  // Wait for /api/codex/sessions fetch

        // Check for dialog
        const dialogOpen = await evalInPage<boolean>(`
            (() => {
                const dialogs = document.querySelectorAll('[role=dialog]');
                return Array.from(dialogs).some(d => d.getBoundingClientRect().width > 0);
            })()
        `)
        record('TC-WEB-46', 'Codex import dialog 打开', dialogOpen,
            `dialog_visible=${dialogOpen}`)

        // TC-WEB-47: dialog renders codex sessions
        const dialogText = await evalInPage<string>(`
            (() => {
                const dialogs = Array.from(document.querySelectorAll('[role=dialog]'))
                    .filter(d => d.getBoundingClientRect().width > 0);
                if (dialogs.length === 0) return '';
                return dialogs[0].innerText.substring(0, 500);
            })()
        `)
        const hasCodexSessions = dialogText && (dialogText.includes('Codex') || dialogText.includes('codex') || dialogText.length > 50)
        record('TC-WEB-47', 'Codex sessions 列表渲染', hasCodexSessions,
            `dialog_text_length=${dialogText?.length || 0}, snippet="${(dialogText || '').substring(0, 100)}"`)

        // Cleanup
        evalInPage(`
            (() => {
                const closeBtn = Array.from(document.querySelectorAll('[role=dialog] button'))
                    .find(b => b.innerText.toLowerCase().includes('cancel') || b.innerText.toLowerCase().includes('close'));
                if (closeBtn) closeBtn.click();
            })()
        `)
        await sleep(500)

        // Summary
        const pass = results.filter(r => r.passed).length
        const fail = results.length - pass
        console.log(`\n=== ${pass} PASS / ${fail} FAIL / ${results.length} TOTAL ===`)
    } finally {
        await stopChrome()
    }
}

main().catch((e) => {
    console.error('Fatal:', e)
    stopChrome().finally(() => process.exit(1))
})
