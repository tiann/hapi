const assert = require('node:assert/strict');
const { test } = require('node:test');
const { latestChecks, evaluateChecks, decide, autoMerge } = require('./auto-merge.cjs');

const HEAD = 'a'.repeat(40);
const OLD = 'c'.repeat(40);
const REQUIRED = ['test', 'integration'];

function run(name, conclusion, databaseId = 1, status = 'COMPLETED') {
    return { __typename: 'CheckRun', databaseId, name, status, conclusion: status === 'COMPLETED' ? conclusion : null };
}

function passingRuns() {
    return [run('test', 'SUCCESS', 1), run('integration', 'SUCCESS', 2), run('windows-codex-mcp', 'SUCCESS', 3), run('build', 'SKIPPED', 4)];
}

function approval(login = 'tiann', state = 'APPROVED', oid = HEAD) {
    return { author: { login }, state, commit: { oid } };
}

function pull(overrides = {}) {
    const { checks = passingRuns(), reviews = [approval()], ...rest } = overrides;
    return {
        number: 7, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', headRefOid: HEAD,
        latestOpinionatedReviews: { nodes: reviews },
        commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: checks } } } }] },
        ...rest,
    };
}

function fakeGithub(pulls, { mergeError } = {}) {
    const merges = [];
    return {
        merges,
        async graphql(query, variables) {
            if (variables.number === undefined) {
                return { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: pulls } } };
            }
            return { repository: { pullRequest: pulls.find(item => item.number === variables.number) } };
        },
        rest: {
            pulls: {
                async merge(params) {
                    if (mergeError) throw new Error(mergeError);
                    merges.push(params);
                },
            },
        },
    };
}

function fakeCore() {
    return { infos: [], warnings: [], failed: null, info(m) { this.infos.push(m); }, warning(m) { this.warnings.push(m); }, setFailed(m) { this.failed = m; } };
}

const context = { repo: { owner: 'tiann', repo: 'hapi' } };
const env = { AUTO_MERGE_TOKEN_CONFIGURED: 'true' };

test('merges an owner-approved PR whose checks passed, pinned to the reviewed head', async () => {
    const github = fakeGithub([pull()]);
    const results = await autoMerge({ github, context, core: fakeCore(), env });
    assert.deepEqual(results, [{ number: 7, action: 'merged' }]);
    assert.deepEqual(github.merges, [{ owner: 'tiann', repo: 'hapi', pull_number: 7, merge_method: 'squash', sha: HEAD }]);
});

test('requires the approver to have approved the current head', () => {
    assert.equal(decide(pull({ reviews: [approval('tiann', 'APPROVED', OLD)] }), 'tiann', REQUIRED).action, 'skip');
    assert.equal(decide(pull({ reviews: [approval('someone')] }), 'tiann', REQUIRED).action, 'skip');
    assert.equal(decide(pull({ reviews: [approval('tiann', 'CHANGES_REQUESTED')] }), 'tiann', REQUIRED).action, 'skip');
});

test('skips drafts and conflicts, and waits while mergeability is unknown', () => {
    assert.equal(decide(pull({ isDraft: true }), 'tiann', REQUIRED).action, 'skip');
    assert.equal(decide(pull({ mergeable: 'CONFLICTING' }), 'tiann', REQUIRED).action, 'skip');
    assert.equal(decide(pull({ mergeable: 'UNKNOWN' }), 'tiann', REQUIRED).action, 'wait');
});

test('waits for missing required checks and for checks still running', () => {
    assert.deepEqual(
        decide(pull({ checks: [run('test', 'SUCCESS')] }), 'tiann', REQUIRED),
        { action: 'wait', reason: 'waiting for required checks: integration' },
    );
    assert.deepEqual(
        decide(pull({ checks: [...passingRuns(), run('pr-review', null, 9, 'IN_PROGRESS')] }), 'tiann', REQUIRED),
        { action: 'wait', reason: 'waiting for checks: pr-review' },
    );
});

test('a failing check blocks the merge even when required checks are missing', () => {
    assert.deepEqual(
        decide(pull({ checks: [run('test', 'FAILURE')] }), 'tiann', REQUIRED),
        { action: 'skip', reason: 'failing checks: test' },
    );
    assert.equal(evaluateChecks({ contexts: { nodes: [{ __typename: 'StatusContext', context: 'ci/ext', state: 'ERROR', createdAt: '2026-10-28T00:00:00Z' }] } }, []).state, 'fail');
});

test('only the latest run of each check counts', () => {
    const rerunPassed = [run('test', 'CANCELLED', 1), run('integration', 'SUCCESS', 2), run('test', 'SUCCESS', 5)];
    assert.equal(decide(pull({ checks: rerunPassed }), 'tiann', REQUIRED).action, 'merge');
    const rerunFailed = [run('test', 'SUCCESS', 1), run('integration', 'SUCCESS', 2), run('test', 'FAILURE', 5)];
    assert.equal(decide(pull({ checks: rerunFailed }), 'tiann', REQUIRED).action, 'skip');
    assert.deepEqual(latestChecks(rerunPassed).map(check => [check.name, check.state]), [['test', 'pass'], ['integration', 'pass']]);
});

test('refuses to merge without the dedicated token but stays quiet with nothing to merge', async () => {
    const core = fakeCore();
    const github = fakeGithub([pull()]);
    assert.deepEqual(await autoMerge({ github, context, core, env: {} }), []);
    assert.match(core.failed, /AUTO_MERGE_TOKEN/);
    assert.equal(github.merges.length, 0);

    const quiet = fakeCore();
    await autoMerge({ github: fakeGithub([pull({ reviews: [] })]), context, core: quiet, env: {} });
    assert.equal(quiet.failed, null);
});

test('reports a rejected merge and keeps going', async () => {
    const core = fakeCore();
    const results = await autoMerge({ github: fakeGithub([pull()], { mergeError: 'Head branch was modified' }), context, core, env });
    assert.deepEqual(results, [{ number: 7, action: 'error', reason: 'Head branch was modified' }]);
    assert.equal(core.warnings.length, 1);
});

function withMergeability(github, states) {
    const graphql = github.graphql;
    github.graphql = async (query, variables) => {
        const data = await graphql(query, variables);
        if (variables.number === undefined) return data;
        return { repository: { pullRequest: { ...data.repository.pullRequest, mergeable: states.shift() } } };
    };
    return github;
}

test('re-reads mergeability while GitHub is still computing it', async () => {
    const github = withMergeability(fakeGithub([pull()]), ['UNKNOWN', 'UNKNOWN', 'MERGEABLE']);
    const sleeps = [];
    const results = await autoMerge({ github, context, core: fakeCore(), env, sleep: async ms => sleeps.push(ms) });
    assert.deepEqual(results, [{ number: 7, action: 'merged' }]);
    assert.equal(sleeps.length, 2);
});

test('stops re-reading mergeability after a bounded number of attempts', async () => {
    const github = withMergeability(fakeGithub([pull()]), Array(10).fill('UNKNOWN'));
    const sleeps = [];
    const results = await autoMerge({ github, context, core: fakeCore(), env, sleep: async ms => sleeps.push(ms) });
    assert.deepEqual(results, [{ number: 7, action: 'wait', reason: 'mergeability is still being computed' }]);
    assert.equal(sleeps.length, 5);
    assert.equal(github.merges.length, 0);
});

test('uses the configured approver and required checks', async () => {
    const github = fakeGithub([pull({ reviews: [approval('maintainer')], checks: [run('lint', 'SUCCESS')] })]);
    const results = await autoMerge({
        github, context, core: fakeCore(),
        env: { ...env, AUTO_MERGE_APPROVER: 'maintainer', AUTO_MERGE_REQUIRED_CHECKS: 'lint' },
    });
    assert.deepEqual(results, [{ number: 7, action: 'merged' }]);
});
