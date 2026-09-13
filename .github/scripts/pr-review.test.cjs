const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
    inputId, marker, botReviews, hasReview, prepareReview, validateResult,
    changedLines, readDiff, renderReview, publishReview,
} = require('./pr-review.cjs');

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const DIFF = `diff --git a/web/src/lib/sessionListSearch.ts b/web/src/lib/sessionListSearch.ts
--- a/web/src/lib/sessionListSearch.ts
+++ b/web/src/lib/sessionListSearch.ts
@@ -244 +245 @@
-        sessions: group.sessions,
+        sessions: sortSessionsBySearchRelevance(group.sessions, index),
`;

function pull() {
    return {
        number: 1842,
        title: 'Rank session search by relevance',
        body: 'Searching Home buries title hits below recent /home/ path matches.',
        head: { sha: HEAD }, base: { sha: BASE, ref: 'main' },
        user: { login: 'contributor' }, state: 'open', draft: false, labels: [],
        html_url: 'https://github.com/tiann/hapi/pull/1842',
    };
}

function assessment(status = 'pass') {
    return {
        status,
        summary: status === 'not_reviewed' ? 'Waiting for the preceding stage.' : 'The problem and proposed behavior are clear.',
        evidence: status === 'not_reviewed' ? [] : ['PR description and existing session list behavior.'],
        suggestions: status === 'needs_changes' ? ['Use the existing capability to meet this use case.'] : [],
    };
}

function result(requirement = 'pass', approach = 'pass') {
    if (requirement !== 'pass') approach = 'not_reviewed';
    return {
        language: 'en',
        requirement: assessment(requirement),
        approach: assessment(approach),
        code: {
            status: approach === 'pass' ? 'reviewed' : 'not_reviewed',
            summary: approach === 'pass' ? 'Reviewed the complete PR diff.' : 'Waiting for the preceding stage.',
            findings: [],
        },
        questions: [requirement, approach].includes('needs_clarification') ? ['Which user-visible behavior is intended?'] : [],
        testing: ['A dedicated regression test would improve coverage.'],
    };
}

function finding(overrides = {}) {
    return {
        severity: 'Minor', title: 'Keep the project pin divider coherent',
        body: 'Searching home interleaves pinned and ordinary rows, producing two pin dividers.',
        path: 'web/src/lib/sessionListSearch.ts', line: 245, side: 'RIGHT',
        suggestion: 'Hide the pin divider during relevance sorting and add a component regression test.',
        ...overrides,
    };
}

function review(overrides = {}) {
    return {
        id: 1, body: 'Previous review\n\n*HAPI Bot*', commit_id: HEAD, state: 'COMMENTED',
        user: { type: 'Bot', login: 'github-actions[bot]' }, submitted_at: '2026-09-13T00:00:00Z',
        ...overrides,
    };
}

function harness(t) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hapi-pr-review-test-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const state = { pull: pull(), reviews: [], posts: [], outputs: {}, diffReads: 0, getCalls: 0 };
    const env = { GITHUB_WORKSPACE: path.resolve(__dirname, '../..'), RUNNER_TEMP: temporary };
    const context = { repo: { owner: 'tiann', repo: 'hapi' }, payload: { pull_request: { number: 1842 } } };
    const core = {
        info: () => {},
        setOutput: (key, value) => { state.outputs[key] = value; },
        summary: { addRaw: () => ({ write: async () => {} }) },
    };
    const github = {
        rest: { pulls: {
            get: async () => {
                state.getCalls++;
                state.onGet?.();
                return { data: structuredClone(state.pull) };
            },
            listReviews: () => {},
            createReview: async payload => {
                state.posts.push(payload);
                if (state.publishError) throw state.publishError;
                return { data: { html_url: 'https://github.com/tiann/hapi/pull/1842#pullrequestreview-1' } };
            },
        } },
        paginate: async (method, params) => {
            assert.equal(method, github.rest.pulls.listReviews);
            assert.equal(params.per_page, 100);
            return structuredClone(state.reviews);
        },
    };
    return {
        state, env,
        prepare: async () => {
            const snapshot = await prepareReview({ github, context, core, env });
            env.REVIEW_CONTEXT_PATH = state.outputs.context_path;
            return snapshot;
        },
        publish: async value => {
            env.REVIEW_RESULT = typeof value === 'string' ? value : JSON.stringify(value);
            return publishReview({ github, context, core, env, getDiff: () => {
                state.diffReads++;
                return DIFF;
            } });
        },
    };
}

for (const [requirement, approach] of [
    ['needs_changes', 'not_reviewed'], ['needs_clarification', 'not_reviewed'],
    ['pass', 'needs_changes'], ['pass', 'needs_clarification'],
]) {
    test(`publishes advisory ${requirement}/${approach} without reviewing code`, async t => {
        const h = harness(t);
        await h.prepare();
        await h.publish(result(requirement, approach));
        assert.equal(h.state.outputs.published, 'true');
        assert.equal(h.state.diffReads, 0);
        assert.equal(h.state.posts.length, 1);
        assert.equal(h.state.posts[0].event, 'COMMENT');
        assert.deepEqual(h.state.posts[0].comments, []);
        assert.match(h.state.posts[0].body, /Code — Not reviewed/);
        assert.doesNotMatch(h.state.posts[0].body, /No reportable code issues/);
    });
}

test('#1842: optional IDF/phrase advice allows the divider regression to be reported', async t => {
    const h = harness(t);
    await h.prepare();
    const value = result();
    value.approach.suggestions = ['Demonstrate IDF benefit with two qualifying sessions.', 'Consider an exact-phrase bonus.'];
    value.code.findings = [finding()];
    await h.publish(value);
    const [posted] = h.state.posts;
    assert.equal(posted.commit_id, HEAD);
    assert.equal(posted.event, 'COMMENT');
    assert.equal(posted.comments.length, 1);
    assert.equal(posted.comments[0].line, 245);
    assert.match(posted.comments[0].body, /two pin dividers/);
    assert.match(posted.body, /Demonstrate IDF benefit/);
    assert.ok(posted.body.indexOf('Requirement — Pass') < posted.body.indexOf('Approach — Pass'));
    assert.ok(posted.body.indexOf('Approach — Pass') < posted.body.indexOf('Code — Reviewed'));
    assert.equal(h.state.posts.length, 1);
});

test('a clear bug fix without an issue can complete all stages with no code findings', async t => {
    const h = harness(t);
    await h.prepare();
    await h.publish(result());
    assert.match(h.state.posts[0].body, /No reportable code issues found/);
    assert.match(h.state.posts[0].body, /Not run \(automation/);
    assert.deepEqual(h.state.posts[0].comments, []);
});

test('renders Chinese status labels and questions, preserving the bot signature', async t => {
    const h = harness(t);
    await h.prepare();
    const value = result('needs_clarification');
    value.language = 'zh';
    value.requirement.summary = '目标使用场景尚不明确。';
    value.requirement.evidence = [];
    value.approach.summary = value.code.summary = '需要先明确需求。';
    value.questions = ['需要支持哪种用户操作？'];
    value.testing = [];
    await h.publish(value);
    const body = h.state.posts[0].body;
    assert.match(body, /评审模式: 首次评审/);
    assert.match(body, /需求合理性 — 需要澄清/);
    assert.match(body, /实现方向 — 未评审/);
    assert.match(body, /代码实现 — 未评审/);
    assert.match(body, /需要支持哪种用户操作/);
    assert.ok(body.endsWith('*HAPI Bot*'));
    assert.doesNotMatch(body, /未发现可报告的代码缺陷/);
});

test('sorts inline findings by severity and supports removed-line anchors in one review', async t => {
    const h = harness(t);
    await h.prepare();
    const value = result();
    value.code.findings = [finding(), finding({ severity: 'Major', side: 'LEFT', line: 244 })];
    await h.publish(value);
    assert.equal(h.state.posts.length, 1);
    assert.equal(h.state.posts[0].comments.length, 2);
    assert.match(h.state.posts[0].comments[0].body, /^\*\*\[Major\]/);
    assert.equal(h.state.posts[0].comments[0].side, 'LEFT');
});

test('skips identical inputs but reviews a description edit on the same head', async t => {
    const h = harness(t);
    const initial = await h.prepare();
    assert.equal(initial.mode, 'initial');
    h.state.reviews = [review({ body: renderReview(result(), initial).body })];
    assert.equal((await h.prepare()).skipped, true);
    assert.equal(h.state.outputs.should_review, 'false');

    h.state.pull.body += '\nThe target is the metadata search, not full-text search.';
    const revised = await h.prepare();
    assert.equal(revised.mode, 'follow_up_context');
    assert.notEqual(revised.input_id, initial.input_id);
    assert.equal(revised.pull.head_sha, initial.pull.head_sha);
    assert.equal(revised.previous_review.id, 1);
    assert.equal(h.state.outputs.should_review, 'true');
    // Text clarification can unlock a full review without any code push.
    await h.publish(result());
    assert.match(h.state.posts[0].body, /follow-up after context changes/);
});

test('legacy review is context, not a new-policy approval or duplicate', async t => {
    const h = harness(t);
    h.state.reviews = [review()];
    const snapshot = await h.prepare();
    assert.equal(snapshot.mode, 'follow_up_context');
    assert.equal(snapshot.previous_review.body, h.state.reviews[0].body);
    assert.equal(h.state.outputs.should_review, 'true');
    h.state.pull.head.sha = 'c'.repeat(40);
    assert.equal((await h.prepare()).mode, 'follow_up_commits');
});

test('fingerprint includes title, body, head, target and policy, excluding normal base-tip movement', () => {
    const value = { head_sha: HEAD, base_sha: BASE, base_ref: 'main', title: 'Title', body: '' };
    const original = inputId(value, 'policy-v2');
    for (const key of ['head_sha', 'base_ref', 'title', 'body']) {
        assert.notEqual(inputId({ ...value, [key]: `${value[key]}changed` }, 'policy-v2'), original);
    }
    assert.notEqual(inputId(value, 'new-policy'), original);
    assert.equal(inputId({ ...value, base_sha: 'c'.repeat(40) }, 'policy-v2'), original);
});

test('requires a submitted review from an allowed bot and an exact generated footer', () => {
    const snapshot = { pull: { head_sha: HEAD }, input_id: 'f'.repeat(64) };
    const body = `Reviewed\n\n${marker(snapshot.input_id)}\n*HAPI Bot*`;
    const valid = review({ body });
    const candidates = [
        valid,
        review({ id: 2, body, user: { type: 'User', login: 'github-actions[bot]' } }),
        review({ id: 3, body, user: { type: 'Bot', login: 'untrusted[bot]' } }),
        review({ id: 4, body, state: 'PENDING' }),
    ];
    assert.deepEqual(botReviews(candidates).map(item => item.id), [1]);
    assert.equal(hasReview(botReviews(candidates), snapshot), true);
    assert.equal(hasReview([review({ body: `${body}\nAn embedded quote, not the review footer.` })], snapshot), false);
    assert.equal(hasReview([review({ body, commit_id: BASE })], snapshot), false);
    assert.equal(botReviews([candidates[2]], 'github-actions[bot], untrusted[bot]').length, 1);
});

for (const field of ['head', 'body', 'title', 'target']) {
    test(`does not publish when ${field} changes during analysis`, async t => {
        const h = harness(t);
        await h.prepare();
        if (field === 'head') h.state.pull.head.sha = 'c'.repeat(40);
        if (field === 'target') h.state.pull.base.ref = 'release';
        if (field === 'body' || field === 'title') h.state.pull[field] += ' changed';
        assert.equal((await h.publish(result())).skipped, true);
        assert.equal(h.state.posts.length, 0);
        assert.equal(h.state.outputs.published, 'false');
    });
}

test('checks freshness again immediately before the write', async t => {
    const h = harness(t);
    await h.prepare();
    h.state.onGet = () => {
        if (h.state.getCalls === 3) h.state.pull.body += ' changed during validation';
    };
    assert.equal((await h.publish(result())).skipped, true);
    assert.equal(h.state.posts.length, 0);
});

test('publication rechecks duplicates after the model finishes', async t => {
    const h = harness(t);
    const snapshot = await h.prepare();
    h.state.reviews = [review({ body: renderReview(result(), snapshot).body })];
    assert.equal((await h.publish(result())).skipped, true);
    assert.equal(h.state.posts.length, 0);
});

for (const change of [
    value => { value.state = 'closed'; },
    value => { value.draft = true; },
    value => { value.labels = [{ name: 'bot-skip' }]; },
]) {
    test('honors current PR eligibility during preparation and publication', async t => {
        const h = harness(t);
        await h.prepare();
        change(h.state.pull);
        assert.equal((await h.publish(result())).skipped, true);
        assert.equal((await h.prepare()).skipped, true);
        assert.equal(h.state.posts.length, 0);
    });
}

for (const [name, makeInvalid] of [
    ['non-JSON output', () => '```json\n{}\n```'],
    ['missing fields', () => '{}'],
    ['continuing after rejected requirement', () => {
        const value = result(); value.requirement = assessment('needs_changes'); return value;
    }],
    ['continuing after rejected approach', () => {
        const value = result(); value.approach = assessment('needs_changes'); return value;
    }],
    ['skipping code after both stages pass', () => {
        const value = result(); value.code.status = 'not_reviewed'; return value;
    }],
    ['findings in skipped code stage', () => {
        const value = result('needs_changes'); value.code.findings = [finding()]; return value;
    }],
    ['advice in skipped approach', () => {
        const value = result('needs_changes'); value.approach.suggestions = ['Unreviewed design advice']; return value;
    }],
    ['clarification without questions', () => {
        const value = result('needs_clarification'); value.questions = []; return value;
    }],
    ['rejection without evidence', () => {
        const value = result('needs_changes'); value.requirement.evidence = []; return value;
    }],
    ['too many questions', () => {
        const value = result('needs_clarification'); value.questions = Array(5).fill('Question?'); return value;
    }],
    ['finding outside the diff', () => {
        const value = result(); value.code.findings = [finding({ line: 1 })]; return value;
    }],
]) {
    test(`rejects ${name} without posting`, async t => {
        const h = harness(t);
        await h.prepare();
        await assert.rejects(h.publish(makeInvalid()));
        assert.equal(h.state.posts.length, 0);
        assert.equal(h.state.outputs.published, 'false');
    });
}

test('an API failure propagates without retrying the atomic write', async t => {
    const h = harness(t);
    await h.prepare();
    h.state.publishError = new Error('GitHub permission denied');
    await assert.rejects(h.publish(result()), /GitHub permission denied/);
    assert.equal(h.state.posts.length, 1);
    assert.equal(h.state.outputs.published, 'false');
});

test('rejects a modified review snapshot', async t => {
    const h = harness(t);
    const snapshot = await h.prepare();
    snapshot.pull.title = 'Changed without updating the fingerprint';
    fs.writeFileSync(h.env.REVIEW_CONTEXT_PATH, JSON.stringify(snapshot));
    await assert.rejects(h.publish(result()), /Invalid or modified review context/);
    assert.equal(h.state.posts.length, 0);
});

test('prompt JSON examples satisfy the publisher contract', () => {
    const prompt = fs.readFileSync(path.resolve(__dirname, '../prompts/codex-pr-review.md'), 'utf8');
    const examples = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
    assert.equal(examples.length, 2);
    validateResult(JSON.stringify(examples[0]));
    examples[0].code.findings = [examples[1]];
    validateResult(JSON.stringify(examples[0]));
});

test('reads the fixed head against its merge base, including spaces, Unicode, renames and deletions', t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hapi-review-diff-test-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd: temporary, encoding: 'utf8' });
    const commit = () => git('-c', 'user.name=Review test', '-c', 'user.email=review@example.invalid',
        '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Fixture');
    git('init', '--quiet');
    for (const name of ['space name.ts', '中文.ts', 'old.ts', 'deleted.ts']) {
        fs.writeFileSync(path.join(temporary, name), `file: ${name}\ntwo\nthree\nfour\nfive\n`);
    }
    git('add', '.');
    commit();
    const base = git('rev-parse', 'HEAD').trim();
    fs.renameSync(path.join(temporary, 'old.ts'), path.join(temporary, 'new.ts'));
    fs.unlinkSync(path.join(temporary, 'deleted.ts'));
    for (const name of ['space name.ts', '中文.ts', 'new.ts']) {
        // Diff-like source content must not be mistaken for a file header.
        fs.writeFileSync(path.join(temporary, name), `file: ${name === 'new.ts' ? 'old.ts' : name}\n++ source text\nthree\nfour\nfive\n`);
    }
    git('add', '.');
    commit();
    const head = git('rev-parse', 'HEAD').trim();
    git('checkout', '--quiet', '--detach', base);
    fs.writeFileSync(path.join(temporary, 'base-only.ts'), 'A change on the target branch only.\n');
    git('add', '.');
    commit();
    const diff = readDiff({ pull: { base_sha: git('rev-parse', 'HEAD').trim(), head_sha: head } }, temporary);
    const files = changedLines(diff);
    for (const name of ['space name.ts', '中文.ts', 'new.ts']) {
        assert.deepEqual(files.get(name), { LEFT: [[2, 2]], RIGHT: [[2, 2]] }, name);
    }
    assert.deepEqual(files.get('deleted.ts'), { LEFT: [[1, 5]], RIGHT: [] });
    assert.equal(files.has('base-only.ts'), false);
});
