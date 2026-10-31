// Merges open PRs that the approver approved at their current head once
// every check on that head has passed. Runs from trusted default-branch code.

const DEFAULT_REQUIRED_CHECKS = ['test', 'integration', 'windows-codex-mcp'];
const PASSING_CONCLUSIONS = ['SUCCESS', 'NEUTRAL', 'SKIPPED'];
const MERGEABILITY_ATTEMPTS = 6;
const MERGEABILITY_DELAY_MS = 5000;

const OPEN_PULLS_QUERY = `query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number isDraft headRefOid
        latestOpinionatedReviews(first: 100) { nodes { author { login } state commit { oid } } }
      }
    }
  }
}`;

const PULL_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number state isDraft mergeable headRefOid
      latestOpinionatedReviews(first: 100) { nodes { author { login } state commit { oid } } }
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              contexts(first: 100) {
                pageInfo { hasNextPage }
                nodes {
                  __typename
                  ... on CheckRun { databaseId name status conclusion }
                  ... on StatusContext { context state createdAt }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

function parseList(value) {
    const items = (value || '').split(',').map(item => item.trim()).filter(Boolean);
    return items.length ? items : null;
}

function approvedAtHead(pull, approver) {
    return (pull.latestOpinionatedReviews?.nodes || []).some(review =>
        review.author?.login === approver
        && review.state === 'APPROVED'
        && review.commit?.oid === pull.headRefOid
    );
}

// Re-runs and repeated triggers leave several runs with one name on a commit;
// only the most recent one describes the current state of that check.
function latestChecks(contexts) {
    const latest = new Map();
    for (const node of contexts) {
        const check = node.__typename === 'StatusContext'
            ? { key: `status:${node.context}`, name: node.context, order: Date.parse(node.createdAt) || 0, state: statusState(node.state) }
            : { key: `check:${node.name}`, name: node.name, order: node.databaseId || 0, state: checkRunState(node) };
        const previous = latest.get(check.key);
        if (!previous || check.order >= previous.order) latest.set(check.key, check);
    }
    return [...latest.values()];
}

function checkRunState(run) {
    if (run.status !== 'COMPLETED') return 'pending';
    return PASSING_CONCLUSIONS.includes(run.conclusion) ? 'pass' : 'fail';
}

function statusState(state) {
    if (state === 'SUCCESS') return 'pass';
    return state === 'PENDING' || state === 'EXPECTED' ? 'pending' : 'fail';
}

function evaluateChecks(rollup, requiredChecks) {
    const contexts = rollup?.contexts;
    if (contexts?.pageInfo?.hasNextPage) return { state: 'pending', reason: 'too many checks to evaluate on one page' };
    const checks = latestChecks(contexts?.nodes || []);
    const failed = checks.filter(check => check.state === 'fail').map(check => check.name);
    if (failed.length) return { state: 'fail', reason: `failing checks: ${failed.join(', ')}` };
    const names = new Set(checks.filter(check => check.key.startsWith('check:')).map(check => check.name));
    const missing = requiredChecks.filter(name => !names.has(name));
    if (missing.length) return { state: 'pending', reason: `waiting for required checks: ${missing.join(', ')}` };
    const pending = checks.filter(check => check.state === 'pending').map(check => check.name);
    if (pending.length) return { state: 'pending', reason: `waiting for checks: ${pending.join(', ')}` };
    return { state: 'pass' };
}

function decide(pull, approver, requiredChecks) {
    if (!pull || pull.state !== 'OPEN') return { action: 'skip', reason: 'PR is no longer open' };
    if (pull.isDraft) return { action: 'skip', reason: 'PR is a draft' };
    if (!approvedAtHead(pull, approver)) return { action: 'skip', reason: `no approval from ${approver} at the current head` };
    if (pull.mergeable === 'CONFLICTING') return { action: 'skip', reason: 'PR has merge conflicts' };
    if (pull.mergeable !== 'MERGEABLE') return { action: 'wait', reason: 'mergeability is still being computed' };
    const commit = pull.commits?.nodes?.[0]?.commit;
    if (commit?.oid !== pull.headRefOid) return { action: 'wait', reason: 'head commit changed while loading' };
    const checks = evaluateChecks(commit.statusCheckRollup, requiredChecks);
    if (checks.state === 'fail') return { action: 'skip', reason: checks.reason };
    if (checks.state === 'pending') return { action: 'wait', reason: checks.reason };
    return { action: 'merge' };
}

async function listOpenPulls(github, owner, repo) {
    const pulls = [];
    let cursor = null;
    do {
        const { repository } = await github.graphql(OPEN_PULLS_QUERY, { owner, repo, cursor });
        const page = repository.pullRequests;
        pulls.push(...page.nodes);
        cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);
    return pulls;
}

// GitHub computes mergeability lazily and resets it whenever the base branch
// moves, so a first read (and every read after a merge) is often UNKNOWN.
async function loadDecision(github, request, approver, requiredChecks, sleep) {
    for (let attempt = 1; ; attempt++) {
        const { repository } = await github.graphql(PULL_QUERY, request);
        const pull = repository.pullRequest;
        const decision = decide(pull, approver, requiredChecks);
        if (pull?.mergeable !== 'UNKNOWN' || attempt >= MERGEABILITY_ATTEMPTS) return { pull, decision };
        await sleep(MERGEABILITY_DELAY_MS);
    }
}

async function autoMerge({ github, context, core, env = process.env, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    const { owner, repo } = context.repo;
    const approver = env.AUTO_MERGE_APPROVER || owner;
    const requiredChecks = parseList(env.AUTO_MERGE_REQUIRED_CHECKS) || DEFAULT_REQUIRED_CHECKS;

    const candidates = (await listOpenPulls(github, owner, repo))
        .filter(pull => !pull.isDraft && approvedAtHead(pull, approver));
    if (!candidates.length) {
        core.info(`No open PRs approved by ${approver} at their current head.`);
        return [];
    }
    // Merges made with GITHUB_TOKEN do not trigger push workflows on the base
    // branch, so refuse to merge without the dedicated token.
    if (env.AUTO_MERGE_TOKEN_CONFIGURED !== 'true') {
        core.setFailed('AUTO_MERGE_TOKEN secret is not configured; approved PRs were not merged.');
        return [];
    }

    const results = [];
    for (const { number } of candidates) {
        const loaded = await loadDecision(github, { owner, repo, number }, approver, requiredChecks, sleep);
        const { pull } = loaded;
        let { decision } = loaded;
        if (decision.action === 'merge') {
            try {
                // Pinning the reviewed head refuses the merge if new commits arrived.
                await github.rest.pulls.merge({ owner, repo, pull_number: number, merge_method: 'squash', sha: pull.headRefOid });
                decision = { action: 'merged' };
            } catch (error) {
                decision = { action: 'error', reason: error.message };
                core.warning(`#${number}: merge failed: ${error.message}`);
            }
        }
        core.info(`#${number}: ${decision.action}${decision.reason ? ` (${decision.reason})` : ''}`);
        results.push({ number, ...decision });
    }
    return results;
}

module.exports = { approvedAtHead, latestChecks, evaluateChecks, decide, autoMerge };
