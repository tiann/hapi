/*
 * Integration test: yolo mode + permission mode UI.
 *
 * Both controls are on the NewSession form. The default Claude
 * flavor exposes a permission mode selector; the yolo toggle
 * applies across flavors. This spec verifies they render, can be
 * flipped, and that flipping yolo persists to localStorage
 * (`hapi:newSession:yolo`).
 *
 * Run with: `bun run e2e/integration/yolo-permission.mts`
 *
 * Required env: HAPI_E2E_TOKEN (CLI access token from hub startup).
 */

import { startChrome, stopChrome, ENV, evalInPage, isVisible, sleep } from '../harness'

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
    await startChrome()
    try {
        // 1. Sign in
        await evalInPage(`fetch('${ENV.WEB_URL}/')`)
        evalInPage(`
            (() => {
                const input = document.querySelector('input[type=password]');
                if (!input) return { skip: 'already logged in' };
                input.focus();
            })()
        `)
        const isLogin = evalInPage<boolean>(`!!document.querySelector('input[type=password]')`)
        if (isLogin) {
            await evalInPage(`
                (() => {
                    const input = document.querySelector('input[type=password]');
                    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                    setter.call(input, '${TOKEN}');
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Sign In'));
                    btn?.click();
                })()
            `)
            await sleep(3000)
        }

        // 2. Navigate to /sessions/new
        await evalInPage(`window.location.assign('${ENV.WEB_URL}/sessions/new')`)
        await sleep(2000)

        // TC-WEB-41: yolo toggle visible
        const yoloVisible = isVisible('input[type=checkbox]')  // YoloToggle uses checkbox
        record('TC-WEB-41', 'Yolo toggle 渲染', yoloVisible,
            `isVisible(checkbox)=${yoloVisible}, page_url=${await evalInPage('location.pathname')}`)

        // TC-WEB-42: yolo toggle flips state
        const beforeState = await evalInPage<boolean>(`
            (() => {
                const cb = document.querySelector('input[type=checkbox]');
                return cb ? cb.checked : null;
            })()
        `)
        evalInPage(`
            (() => {
                const cb = document.querySelector('input[type=checkbox]');
                if (cb) cb.click();
            })()
        `)
        await sleep(500)
        const afterState = await evalInPage<boolean>(`
            (() => {
                const cb = document.querySelector('input[type=checkbox]');
                return cb ? cb.checked : null;
            })()
        `)
        const flipped = beforeState !== afterState && afterState !== null
        record('TC-WEB-42', 'Yolo toggle 切换状态', flipped,
            `before=${beforeState}, after=${afterState}`)

        // TC-WEB-43: yolo persists to localStorage
        const persisted = await evalInPage<string>(`localStorage.getItem('hapi:newSession:yolo')`)
        record('TC-WEB-43', 'Yolo state 持久化', persisted !== null,
            `localStorage[hapi:newSession:yolo]=${persisted}`)

        // TC-WEB-44: permission mode selector (Claude flavor)
        // Need to switch to Claude agent first
        evalInPage(`
            (() => {
                const claudeLabel = Array.from(document.querySelectorAll('label')).find(l => l.innerText.includes('Claude'));
                if (claudeLabel) claudeLabel.click();
            })()
        `)
        await sleep(1000)
        const hasPermSelector = await evalInPage<boolean>(`
            (() => {
                const text = document.body.innerText;
                return text.includes('Permission') || text.includes('权限') || text.includes('Default') || text.includes('Plan');
            })()
        `)
        record('TC-WEB-44', 'Permission mode 渲染 (Claude)', hasPermSelector,
            `has_perm_text=${hasPermSelector}`)

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
