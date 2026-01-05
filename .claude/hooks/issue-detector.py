#!/usr/bin/env python3
"""
GitHub Issue Creation Intent Detector - HAPImatic

This UserPromptSubmit hook detects when a user expresses intent to create a GitHub issue
and injects context to trigger the issue-creator subagent.

Trigger patterns include:
- "create/make/generate/open/file a GitHub issue"
- "track this as an issue"
- "turn this into an issue"
- "document this as an issue"
- "let's create an issue"

When triggered, injects additionalContext instructing Claude to invoke the issue-creator
subagent via the Task tool.
"""

import json
import sys
import re


def detect_issue_intent(prompt: str) -> bool:
    """
    Detect if the user prompt expresses intent to create a GitHub issue.

    Uses semantic pattern matching to catch various phrasings.
    """
    prompt_lower = prompt.lower()

    # Primary patterns for issue creation intent
    issue_patterns = [
        # Direct creation verbs + issue
        r"\b(create|make|generate|open|file|add|write|start)\b.*\b(github\s+)?issue\b",
        r"\b(github\s+)?issue\b.*\b(for|about|to track|to document)\b",

        # Tracking/documentation phrases
        r"\btrack\s+(this|that|it)\s+as\s+(an?\s+)?issue\b",
        r"\bturn\s+(this|that|it)\s+into\s+(an?\s+)?issue\b",
        r"\bdocument\s+(this|that|it)\s+as\s+(an?\s+)?issue\b",
        r"\bput\s+(this|that|it)\s+(in|on)\s+(github\s+)?issues?\b",
        r"\badd\s+(this|that|it)\s+to\s+(github\s+)?issues?\b",

        # Collaborative phrases
        r"\blet'?s?\s+(create|make|open|file|write)\s+(an?\s+)?(github\s+)?issue\b",
        r"\bwe\s+should\s+(create|make|open|file)\s+(an?\s+)?(github\s+)?issue\b",
        r"\bcan\s+you\s+(create|make|open|file)\s+(an?\s+)?(github\s+)?issue\b",
        r"\bplease\s+(create|make|open|file)\s+(an?\s+)?(github\s+)?issue\b",

        # Issue as subject
        r"\b(new|a|an)\s+(github\s+)?issue\s+(for|about|regarding|to)\b",
        r"\bgithub\s+issue\s+(should|needs?\s+to)\s+be\s+(created|made|opened)\b",
    ]

    # Check if any pattern matches
    for pattern in issue_patterns:
        if re.search(pattern, prompt_lower):
            return True

    return False


def main():
    """
    Main hook execution.

    Reads prompt from stdin, checks for issue creation intent,
    and outputs JSON to inject context if detected.
    """
    # Load input from stdin
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        # Log error but don't block - allow prompt to proceed
        print(f"Hook error: Invalid JSON input: {e}", file=sys.stderr)
        sys.exit(0)

    prompt = input_data.get("prompt", "")

    # Check for issue creation intent
    if detect_issue_intent(prompt):
        # Inject context to trigger the issue-creator subagent
        output = {
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": (
                    "AUTOMATED TRIGGER: The user has expressed intent to create a GitHub issue. "
                    "You MUST invoke the 'issue-creator' subagent via the Task tool with "
                    "subagent_type='issue-creator' to handle this request. Pass the user's "
                    "full original prompt as the task description. The subagent will handle "
                    "all workflow phases: context gathering, duplicate detection, issue "
                    "composition, labeling, and creation. "
                    "Repository: MattStarfield/hapimatic"
                )
            }
        }
        print(json.dumps(output))

    # Exit successfully - allow prompt to proceed
    sys.exit(0)


if __name__ == "__main__":
    main()
