/**
 * Queued after the operator accepts a Cursor `create_plan` request so the
 * session continues toward the original user task (mirror of Claude's
 * PLAN_FAKE_RESTART after ExitPlanMode approval). Without this, Yes only
 * unblocks ACP and the prompt turn ends — plan complete, task abandoned.
 */
export const CURSOR_PLAN_CONTINUE =
    'The plan was approved. Continue executing it now toward completing the user\'s original request. Do not stop solely because the plan was accepted.';
