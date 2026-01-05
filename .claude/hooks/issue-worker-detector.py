#!/usr/bin/env python3
"""
GitHub Issue Worker Intent Detector - HAPImatic

This UserPromptSubmit hook detects when a user expresses intent to work on, fix,
or address an existing GitHub issue and injects context to trigger the issue-worker
multi-phase workflow.

Trigger patterns include:
- "fix/work on/address/tackle/resolve issue #75"
- "fix that bug", "address the problem we discussed"
- "let's work on issue #X", "can you fix #X"
- "close out issue #X", "finish issue #X"
"""

import json
import sys
import re


def extract_issue_number(prompt: str) -> str | None:
    """
    Extract issue number from the prompt if present.

    Returns the issue number as a string, or None if not found.
    """
    # Match various formats: #75, issue 75, issue #75, issue-75
    patterns = [
        r'#(\d+)',
        r'\bissue\s*#?(\d+)',
        r'\bissue-(\d+)',
        r'\b(?:fix|work\s+on|address|tackle|resolve|handle|debug|implement|close|finish|complete)\s+#?(\d+)\b',
    ]

    prompt_lower = prompt.lower()

    for pattern in patterns:
        match = re.search(pattern, prompt_lower)
        if match:
            return match.group(1)

    return None


def detect_issue_work_intent(prompt: str) -> bool:
    """
    Detect if the user prompt expresses intent to work on an existing GitHub issue.

    Uses semantic pattern matching to catch various phrasings.
    """
    prompt_lower = prompt.lower()

    # Exclude patterns that indicate issue CREATION (handled by issue-creator)
    creation_patterns = [
        r'\b(create|make|generate|open|file|add|write)\b.*\b(github\s+)?issue\b',
        r'\btrack\s+(this|that|it)\s+as\s+(an?\s+)?issue\b',
        r'\bturn\s+(this|that|it)\s+into\s+(an?\s+)?issue\b',
        r'\bdocument\s+(this|that|it)\s+as\s+(an?\s+)?issue\b',
        r'\bnew\s+(github\s+)?issue\b',
    ]

    for pattern in creation_patterns:
        if re.search(pattern, prompt_lower):
            return False

    # Primary patterns for issue WORK intent
    work_patterns = [
        r'\b(fix|work\s+on|address|tackle|resolve|handle|debug|implement|solve)\b.*\b(issue|#\d+)\b',
        r'\b(issue|#)\s*\d+\b.*\b(fix|work|address|tackle|resolve|handle|debug|implement|solve)\b',
        r'\b(close\s+out|finish|complete|wrap\s+up)\b.*\b(issue|#\d+)\b',
        r'\b(issue|#)\s*\d+\b.*\b(close|finish|complete|wrap)\b',
        r'\b(fix|address|tackle|resolve|debug|solve)\s+(that|the|this)\s+(bug|problem|issue|error|enhancement|feature)\b',
        r'\b(work\s+on|handle|implement)\s+(that|the|this)\s+(bug|problem|issue|enhancement|feature)\b',
        r"\blet'?s?\s+(fix|work\s+on|address|tackle|resolve|handle|debug|implement)\b.*\b(issue|#\d+|bug|problem)\b",
        r'\bcan\s+you\s+(fix|work\s+on|address|tackle|resolve|handle|debug|implement)\b.*\b(issue|#\d+|bug|problem)\b',
        r'\bcan\s+you\s+(fix|work\s+on|address|tackle|resolve|handle|debug|implement)\s+#\d+',
        r'\bplease\s+(fix|work\s+on|address|tackle|resolve|handle|debug|implement)\b.*\b(issue|#\d+|bug|problem)\b',
        r'\bplease\s+(fix|work\s+on|address|tackle|resolve|handle|debug|implement)\s+#\d+',
        r'\bissue\s*#?\d+\b.*\b(needs?\s+to\s+be|should\s+be)\s+(fixed|addressed|resolved|handled|implemented)\b',
        r'\b(start|begin)\s+(work(ing)?|fix(ing)?)\s+(on\s+)?(issue\s*)?#?\d+\b',
        r'\b(look\s+at|check\s+out|investigate|examine|review\s+and\s+fix)\s+(issue\s*)?#?\d+\b',
        r'\b(fix|address|resolve|tackle|handle)\s+(that|the)\s+issue\b',
        r'\b(fix|address|resolve|tackle)\b.*\b(we\s+discussed|mentioned|talked\s+about)\b',
        r'\b(we\s+discussed|mentioned|talked\s+about)\b.*\b(fix|address|resolve|tackle)\b',
        # Pattern to detect "use the issue worker agent" or similar
        r'\b(use|invoke|run|trigger)\s+(the\s+)?issue[- ]?worker\b',
    ]

    for pattern in work_patterns:
        if re.search(pattern, prompt_lower):
            return True

    return False


def build_orchestrator_instructions(issue_number: str | None) -> str:
    """
    Build comprehensive orchestrator instructions for multi-phase workflow.
    """

    base_instructions = """
ORCHESTRATOR INSTRUCTIONS FOR ISSUE-WORKER MULTI-PHASE WORKFLOW
================================================================

YOU (the orchestrator) are RESPONSIBLE for managing this workflow. You MUST NOT
delegate the entire workflow to a single subagent call. Instead, you will execute
this as a MULTI-PHASE process with verification between each phase.

CRITICAL REQUIREMENTS:
----------------------
1. Subagent reports are CLAIMS, not facts. You MUST verify all claims.
2. HARD GATES require user approval. You CANNOT proceed without it.
3. All subagent calls MUST use model: "opus"
4. SERVER RESTART WARNING: If implementation requires deploying new binary,
   you MUST warn user that active HAPI sessions will be disconnected.

PHASE STRUCTURE:
----------------

PHASE 1: ANALYSIS (Read-Only)
- Fetch issue details via gh CLI
- Read CLAUDE.md and README.md
- Explore affected codebase areas
- Create analysis document: claudedocs/issue-XX-analysis.md
- HARD GATE: Present findings to user, get approval to proceed

PHASE 2: IMPLEMENTATION (Write Operations)
- Create feature branch (if medium/high complexity)
- Implement changes following existing patterns
- Run typecheck: bun run typecheck
- Run build: bun run build:single-exe
- Playwright verification (for UI changes):
  - Desktop: 1280x800
  - Mobile: 402x874 (iPhone 16 Pro)
  - URL: http://localhost:3007
- Create sentinel: claudedocs/issue-XX-awaiting-approval.md
- HARD GATE: User MUST manually test and approve before proceeding

PHASE 3: CLOSING (handled by issue-closer agent)
- Only triggered after user explicitly approves
- Code review, PR creation/merge, issue close

VERIFICATION CHECKLIST (After EVERY phase):
-------------------------------------------
[ ] Read actual files that were supposedly modified
[ ] Run: git status && git diff
[ ] Compare claimed actions against actual state
[ ] Report ANY discrepancies to user before proceeding
"""

    if issue_number:
        specific_context = f"""
ISSUE CONTEXT:
--------------
Issue Number: #{issue_number}
Repository: MattStarfield/hapimatic
Working Directory: /home/matt/projects/hapimatic
Target Branch: main

BEGIN PHASE 1:
--------------
1. Create directory if needed: mkdir -p claudedocs
2. Fetch issue details:
   gh issue view {issue_number} --repo MattStarfield/hapimatic
3. Read project context:
   - CLAUDE.md for project rules
   - README.md for architecture
4. Explore affected code areas based on issue description
5. Create analysis document: claudedocs/issue-{issue_number}-analysis.md
6. Present findings to user
7. HARD GATE: Wait for user approval before Phase 2
"""
    else:
        specific_context = """
ISSUE IDENTIFICATION NEEDED:
----------------------------
No specific issue number was detected in the user's request.

BEFORE starting the multi-phase workflow:
1. Ask the user which issue they want to work on
2. Optionally list recent open issues to help them decide:
   gh issue list --repo MattStarfield/hapimatic --state open --limit 10
3. Once issue is confirmed, proceed with Phase 1 as described above

Repository: MattStarfield/hapimatic
Working Directory: /home/matt/projects/hapimatic
"""

    return base_instructions + specific_context


def main():
    """
    Main hook execution.

    Reads prompt from stdin, checks for issue work intent,
    and outputs JSON to inject orchestrator instructions.
    """
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"Hook error: Invalid JSON input: {e}", file=sys.stderr)
        sys.exit(0)

    prompt = input_data.get("prompt", "")

    if detect_issue_work_intent(prompt):
        issue_number = extract_issue_number(prompt)
        context_message = build_orchestrator_instructions(issue_number)

        output = {
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": context_message
            }
        }
        print(json.dumps(output))

    sys.exit(0)


if __name__ == "__main__":
    main()
