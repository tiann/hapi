import { trimIdent } from '@/utils/trimIdent';

export const AGY_TITLE_MARKER = 'HAPI_TITLE:';

export const TITLE_INSTRUCTION = trimIdent(`
    HAPI chat title management:
    - Antigravity agy in HAPI does not have an MCP title tool. HAPI will update the chat title by reading a hidden title marker from your response.
    - On your first assistant response, and later only when the main event genuinely changes, start the response with exactly one line:
      ${AGY_TITLE_MARKER} <main event> · <current stage>
    - The " · <current stage>" suffix is optional. Keep titles short and specific, in the user's language, and do not use generic words like "Chat", "Help", or "Task".
    - HAPI will remove this marker before showing your message to the user.
`);

export const HANDOFF_INSTRUCTION = trimIdent(`
    External AI CLI routing (handoff):
    - When the user asks to 调四家, 四家审查, 多模型审查, 交叉审查, second opinion, have all four review, or asks you to consult codex / claude / claude-deepseek / agy, you MUST run the local handoff CLI from your shell/terminal tool. Do not merely explain what you would do.
    - Multi-family review command pattern:
      handoff review --task-file <task-file> --workdir <workdir> --profile heavy --caller-tag "$CODEX_HANDOFF_CALLER_TAG" --run-id <stable-run-id> --output json --output-file <result-json>
    - Single-family delegate command pattern:
      handoff delegate --tool <codex|claude|claude-deepseek|agy> --task-file <task-file> --workdir <workdir> --profile heavy --caller-tag "$CODEX_HANDOFF_CALLER_TAG" --run-id <stable-run-id> --output json --output-file <result-json>
    - Use a real task file for long prompts. If the task needs paths outside the workdir, add --add-dir for each external path.
    - Run the command in the foreground and wait for it to exit before answering. Do NOT say only that the command was started, launched, or is running in the background.
    - After the command exits, read the explicit --output-file JSON. For each result, read its assistant_text_path before summarizing. Never use the newest cache file or raw stdout as the answer.
    - Practical foreground workflow: run the handoff command, then run a second shell command such as python3 heredoc to parse that exact output JSON and print each tool/status/assistant_text_path plus the assistant text. Base your final answer on that parsed output.
    - If the output file is not yet present, poll it until it exists or until the command fails/times out; only then answer.
    - If the shell/terminal tool reports that the command was merely launched or backgrounded, immediately wait/poll the output file and read it before replying; never end your turn with only a progress update like “started”, “launched”, “running”, or “please wait”.
    - If handoff is unavailable or fails, report the exact command, exit code, and error; do not pretend a review happened.
`);

export const agySystemPrompt = `${TITLE_INSTRUCTION}\n\n${HANDOFF_INSTRUCTION}`;
