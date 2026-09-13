const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SIGNATURE = '*HAPI Bot*';
const VERSION = 2;
const SEVERITIES = ['Blocker', 'Major', 'Minor', 'Nit'];
const DECISIONS = ['pass', 'needs_changes', 'needs_clarification'];

function hash(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function policyDigest(workspace) {
    return hash([
        VERSION,
        fs.readFileSync(path.join(workspace, '.github/prompts/codex-pr-review.md'), 'utf8'),
        fs.readFileSync(__filename, 'utf8'),
    ]);
}

function snapshotPull(pull) {
    return {
        number: pull.number,
        title: pull.title,
        body: pull.body ?? '',
        head_sha: pull.head.sha,
        base_sha: pull.base.sha,
        base_ref: pull.base.ref,
        author: pull.user?.login ?? '',
        url: pull.html_url,
    };
}

function inputId(pull, digest) {
    // A moving base tip alone does not invalidate a review of a fixed head.
    // Retargeting the PR does: it changes the intended merge-base comparison.
    return hash([pull.head_sha, pull.base_ref, pull.title, pull.body, digest]);
}

function marker(id) {
    return `<!-- hapi-pr-review:v${VERSION}:${id} -->`;
}

function botReviews(reviews, logins = '') {
    const allowed = (logins || 'github-actions[bot]').split(',').map(login => login.trim()).filter(Boolean);
    return reviews.filter(review =>
        review.state !== 'PENDING'
        && review.user?.type === 'Bot'
        && allowed.includes(review.user.login)
        && (review.body || '').includes(SIGNATURE)
    ).sort((left, right) =>
        Date.parse(right.submitted_at || right.created_at || 0)
        - Date.parse(left.submitted_at || left.created_at || 0)
        || right.id - left.id
    );
}

function hasReview(reviews, snapshot) {
    const footer = `${marker(snapshot.input_id)}\n${SIGNATURE}`;
    return reviews.some(review =>
        review.commit_id === snapshot.pull.head_sha
        && (review.body || '').trimEnd().endsWith(footer)
    );
}

function skipReason(pull) {
    if (pull.state !== 'open') return 'PR is no longer open';
    if (pull.draft) return 'PR is a draft';
    if (pull.labels?.some(label => label.name === 'bot-skip')) return 'PR has bot-skip label';
    return null;
}

function requestContext(context) {
    const pullNumber = context.payload.pull_request.number;
    if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) throw new Error('Invalid PR number');
    return { ...context.repo, pull_number: pullNumber };
}

function skip(core, reason) {
    core.info(`Skipping PR review: ${reason}.`);
    core.setOutput('skip_reason', reason);
    return { skipped: true, reason };
}

async function listBotReviews(github, request, env) {
    return botReviews(await github.paginate(github.rest.pulls.listReviews, {
        ...request,
        per_page: 100,
    }), env.HAPI_BOT_LOGINS);
}

async function prepareReview({ github, context, core, env = process.env }) {
    core.setOutput('should_review', 'false');
    const request = requestContext(context);
    const { data: pull } = await github.rest.pulls.get(request);
    const reason = skipReason(pull);
    if (reason) return skip(core, reason);

    const digest = policyDigest(env.GITHUB_WORKSPACE);
    const snapshot = {
        version: VERSION,
        repository: `${request.owner}/${request.repo}`,
        pull: snapshotPull(pull),
        policy_digest: digest,
    };
    for (const sha of [snapshot.pull.head_sha, snapshot.pull.base_sha]) {
        if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error('Invalid review commit SHA');
    }
    snapshot.input_id = inputId(snapshot.pull, digest);
    const reviews = await listBotReviews(github, request, env);
    if (hasReview(reviews, snapshot)) return skip(core, 'these inputs have already been reviewed');

    const latest = reviews[0];
    snapshot.mode = !latest ? 'initial'
        : latest.commit_id === snapshot.pull.head_sha ? 'follow_up_context' : 'follow_up_commits';
    // Legacy reviews remain useful evidence, but cannot satisfy the new input marker.
    snapshot.previous_review = latest ? {
        id: latest.id,
        commit_id: latest.commit_id,
        body: latest.body,
    } : null;
    const contextPath = path.join(env.RUNNER_TEMP, 'hapi-pr-review-context.json');
    fs.writeFileSync(contextPath, JSON.stringify(snapshot, null, 2));
    core.setOutput('context_path', contextPath);
    core.setOutput('current_head_sha', snapshot.pull.head_sha);
    core.setOutput('base_sha', snapshot.pull.base_sha);
    core.setOutput('should_review', 'true');
    return snapshot;
}

function requireObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
}

function requireText(value, label) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be non-empty text`);
}

function requireTexts(value, label) {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    value.forEach((item, index) => requireText(item, `${label}[${index}]`));
}

function validateAssessment(value, label, allowSkipped) {
    requireObject(value, label);
    const statuses = allowSkipped ? [...DECISIONS, 'not_reviewed'] : DECISIONS;
    if (!statuses.includes(value.status)) throw new Error(`${label}.status is invalid`);
    requireText(value.summary, `${label}.summary`);
    requireTexts(value.evidence, `${label}.evidence`);
    requireTexts(value.suggestions, `${label}.suggestions`);
    if (value.status === 'not_reviewed') {
        if (value.evidence.length || value.suggestions.length) {
            throw new Error(`${label}: a skipped stage cannot contain evidence or suggestions`);
        }
    } else if (value.status !== 'needs_clarification' && value.evidence.length === 0) {
        throw new Error(`${label}: a decision requires evidence`);
    }
    if (value.status === 'needs_changes' && value.suggestions.length === 0) {
        throw new Error(`${label}: needs_changes requires an actionable suggestion`);
    }
}

function validateResult(raw) {
    const result = JSON.parse(raw);
    requireObject(result, 'result');
    if (!['en', 'zh'].includes(result.language)) throw new Error('language must be en or zh');
    validateAssessment(result.requirement, 'requirement', false);
    validateAssessment(result.approach, 'approach', true);
    requireObject(result.code, 'code');
    if (!['reviewed', 'not_reviewed'].includes(result.code.status)) throw new Error('code.status is invalid');
    requireText(result.code.summary, 'code.summary');
    if (!Array.isArray(result.code.findings)) throw new Error('code.findings must be an array');
    requireTexts(result.questions, 'questions');
    requireTexts(result.testing, 'testing');
    if (result.questions.length > 4) throw new Error('At most four questions are allowed');

    const requirementPassed = result.requirement.status === 'pass';
    if (requirementPassed === (result.approach.status === 'not_reviewed')) {
        throw new Error('approach must be reviewed if and only if requirement passes');
    }
    const approachPassed = requirementPassed && result.approach.status === 'pass';
    if (approachPassed !== (result.code.status === 'reviewed')) {
        throw new Error('code must be reviewed if and only if both preceding stages pass');
    }
    if (!approachPassed && result.code.findings.length) {
        throw new Error('A skipped code review cannot contain findings');
    }
    if ([result.requirement, result.approach].some(stage => stage.status === 'needs_clarification')
        && result.questions.length === 0) {
        throw new Error('needs_clarification requires a concrete question');
    }

    for (const [index, finding] of result.code.findings.entries()) {
        const label = `code.findings[${index}]`;
        requireObject(finding, label);
        if (!SEVERITIES.includes(finding.severity)) throw new Error(`${label}.severity is invalid`);
        for (const key of ['title', 'body', 'path', 'suggestion']) requireText(finding[key], `${label}.${key}`);
        if (!Number.isSafeInteger(finding.line) || finding.line < 1) throw new Error(`${label}.line is invalid`);
        if (!['LEFT', 'RIGHT'].includes(finding.side)) throw new Error(`${label}.side is invalid`);
    }
    return result;
}

// With zero context, every line in each hunk range is changed. Keep the new
// filename for renamed files on both sides, matching GitHub review comments.
function changedLines(diff) {
    const files = new Map();
    let oldPath;
    let newPath;
    let inHunks = false;
    const decodePath = value => {
        // Git appends a tab to ambiguous unquoted headers (e.g. spaces).
        // Literal tabs in filenames are C-quoted instead.
        const pathname = value.split('\t', 1)[0];
        const decoded = pathname.startsWith('"') ? JSON.parse(pathname) : pathname;
        return decoded === '/dev/null' ? null : decoded.replace(/^[ab]\//, '');
    };
    for (const line of diff.split('\n')) {
        if (line.startsWith('diff --git ')) {
            oldPath = newPath = null;
            inHunks = false;
        } else if (!inHunks && line.startsWith('--- ')) {
            oldPath = decodePath(line.slice(4));
        } else if (!inHunks && line.startsWith('+++ ')) {
            newPath = decodePath(line.slice(4));
        } else {
            const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
            if (!hunk) continue;
            inHunks = true;
            const filename = newPath ?? oldPath;
            if (!filename) throw new Error('Diff hunk has no filename');
            const ranges = files.get(filename) ?? { LEFT: [], RIGHT: [] };
            for (const [side, start, count] of [
                ['LEFT', Number(hunk[1]), Number(hunk[2] ?? 1)],
                ['RIGHT', Number(hunk[3]), Number(hunk[4] ?? 1)],
            ]) {
                if (count) ranges[side].push([start, start + count - 1]);
            }
            files.set(filename, ranges);
        }
    }
    return files;
}

function readDiff(snapshot, workspace) {
    const options = { cwd: workspace, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
    const base = execFileSync('git', ['merge-base', snapshot.pull.base_sha, snapshot.pull.head_sha], options).trim();
    return execFileSync('git', [
        '-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color',
        '--unified=0', '--inter-hunk-context=0', '--find-renames', base, snapshot.pull.head_sha, '--',
    ], options);
}

const LABELS = {
    en: {
        mode: 'Review mode', initial: 'initial', follow_up_context: 'follow-up after context changes',
        follow_up_commits: 'follow-up after new commits',
        requirement: 'Requirement', approach: 'Approach', code: 'Code', testing: 'Testing', questions: 'Questions',
        pass: 'Pass', needs_changes: 'Needs changes', needs_clarification: 'Needs clarification',
        not_reviewed: 'Not reviewed', reviewed: 'Reviewed', evidence: 'Evidence', suggestions: 'Suggestions',
        fix: 'Suggested fix', noFindings: 'No reportable code issues found.',
        notRun: 'Not run (automation; PR code execution is prohibited).',
    },
    zh: {
        mode: '评审模式', initial: '首次评审', follow_up_context: '说明更新后的复评',
        follow_up_commits: '新提交后的复评',
        requirement: '需求合理性', approach: '实现方向', code: '代码实现', testing: '验证情况', questions: '待澄清问题',
        pass: '通过', needs_changes: '需要调整', needs_clarification: '需要澄清',
        not_reviewed: '未评审', reviewed: '已评审', evidence: '依据', suggestions: '建议',
        fix: '修复建议', noFindings: '未发现可报告的代码缺陷。',
        notRun: '未运行测试（自动评审禁止执行 PR 代码）。',
    },
};

function renderReview(result, snapshot) {
    const labels = LABELS[result.language];
    const parts = [`${labels.mode}: ${labels[snapshot.mode]}`];
    for (const key of ['requirement', 'approach']) {
        const stage = result[key];
        parts.push(`**${labels[key]} — ${labels[stage.status]}**`, stage.summary);
        if (stage.evidence.length) parts.push(`**${labels.evidence}**\n\n${stage.evidence.map(item => `- ${item}`).join('\n')}`);
        if (stage.suggestions.length) parts.push(`**${labels.suggestions}**\n\n${stage.suggestions.map(item => `- ${item}`).join('\n')}`);
    }
    parts.push(`**${labels.code} — ${labels[result.code.status]}**`, result.code.summary);
    const findings = [...result.code.findings].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
    const comments = findings.map(finding => ({
        path: finding.path,
        line: finding.line,
        side: finding.side,
        body: `**[${finding.severity}] ${finding.title}**\n\n${finding.body}\n\n**${labels.fix}**\n\n${finding.suggestion}`,
    }));
    if (findings.length) {
        parts.push(findings.map(finding => `- [${finding.severity}] ${finding.title} — \`${finding.path}:${finding.line}\``).join('\n'));
    } else if (result.code.status === 'reviewed') {
        parts.push(labels.noFindings);
    }
    if (result.questions.length) parts.push(`**${labels.questions}**\n\n${result.questions.map(item => `- ${item}`).join('\n')}`);
    parts.push(`**${labels.testing}**`, labels.notRun);
    if (result.testing.length) parts.push(result.testing.map(item => `- ${item}`).join('\n'));
    parts.push(`${marker(snapshot.input_id)}\n${SIGNATURE}`);
    return { event: 'COMMENT', commit_id: snapshot.pull.head_sha, body: parts.join('\n\n'), comments };
}

async function publishReview({ github, context, core, env = process.env, getDiff = readDiff }) {
    core.setOutput('published', 'false');
    const request = requestContext(context);
    const snapshot = JSON.parse(fs.readFileSync(env.REVIEW_CONTEXT_PATH, 'utf8'));
    const digest = policyDigest(env.GITHUB_WORKSPACE);
    if (snapshot.version !== VERSION || snapshot.repository !== `${request.owner}/${request.repo}`
        || snapshot.pull?.number !== request.pull_number || snapshot.policy_digest !== digest
        || inputId(snapshot.pull, digest) !== snapshot.input_id
        || !['initial', 'follow_up_context', 'follow_up_commits'].includes(snapshot.mode)) {
        throw new Error('Invalid or modified review context');
    }
    const staleReason = pull => skipReason(pull)
        ?? (inputId(snapshotPull(pull), digest) !== snapshot.input_id ? 'PR inputs changed during review' : null);
    const { data: live } = await github.rest.pulls.get(request);
    const reason = staleReason(live);
    if (reason) return skip(core, reason);
    if (hasReview(await listBotReviews(github, request, env), snapshot)) {
        return skip(core, 'these inputs have already been reviewed');
    }

    const result = validateResult(env.REVIEW_RESULT);
    if (result.code.findings.length) {
        const lines = changedLines(getDiff(snapshot, env.GITHUB_WORKSPACE));
        for (const finding of result.code.findings) {
            if (!lines.get(finding.path)?.[finding.side].some(([start, end]) => finding.line >= start && finding.line <= end)) {
                throw new Error(`Finding is not on a changed line: ${finding.path}:${finding.line} (${finding.side})`);
            }
        }
    }
    const payload = renderReview(result, snapshot);
    // Keep the final freshness check adjacent to the single atomic write.
    const { data: latest } = await github.rest.pulls.get(request);
    const latestReason = staleReason(latest);
    if (latestReason) return skip(core, latestReason);
    const { data: review } = await github.rest.pulls.createReview({ ...request, ...payload });
    core.setOutput('published', 'true');
    core.setOutput('review_url', review.html_url);
    await core.summary.addRaw(payload.body).write();
    return review;
}

module.exports = { inputId, marker, botReviews, hasReview, prepareReview, validateResult, changedLines, readDiff, renderReview, publishReview };
