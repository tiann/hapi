#!/usr/bin/env python3
"""
GitHub Issue Approval Detector - HAPImatic

This UserPromptSubmit hook detects when a user approves changes made by the
issue-worker agent and triggers the issue-closer agent to handle the closing
workflow (code review, PR, merge, close).

DETECTION STRATEGY:
===================

1. Pattern Matching: Detect approval phrases like "LGTM", "approved", "ship it"
2. Context Verification: Check for awaiting-approval sentinel file
3. Issue Number Extraction: Get issue number from sentinel file

The hook only triggers if BOTH conditions are met:
- User message contains approval pattern
- Awaiting-approval sentinel file exists

TRIGGER PATTERNS:
- "lgtm", "looks good", "ship it", "approved", "proceed"
- "merge it", "close the issue", "go ahead"
- "changes approved", "i approve"
- Explicit: "use issue-closer", "invoke issue-closer"
"""

import json
import sys
import re
from pathlib import Path


def detect_approval_intent(prompt: str) -> bool:
    """
    Detect if the user prompt expresses approval of implemented changes.

    Returns True if approval pattern is detected.
    """
    prompt_lower = prompt.lower()

    # Exclude patterns that indicate disapproval or need for changes
    disapproval_patterns = [
        r'\b(not\s+)?(don\'?t|do\s+not)\s+(approve|lgtm|ship|merge|close)\b',
        r'\b(no|nope|nah),?\s*(don\'?t|do\s+not)?\s*(approve|merge|close)\b',
        r'\b(needs?\s+(more\s+)?changes?|needs?\s+work|not\s+ready)\b',
        r'\b(fix|change|update|modify)\s+(this|that|it)\s+first\b',
        r'\b(wait|hold|stop|pause)\b.*\b(merge|close|approve)\b',
        r'\bactually,?\s*(no|wait|hold)\b',
    ]

    for pattern in disapproval_patterns:
        if re.search(pattern, prompt_lower):
            return False

    # Approval patterns
    approval_patterns = [
        # Direct approval phrases
        r'\blgtm\b',
        r'\bship\s+it\b',
        r'\bapproved?\b',
        r'\bproceed\b',
        r'\bgo\s+ahead\b',

        # Looks good variants
        r'\blooks?\s+good\b',
        r'\blooks?\s+great\b',
        r'\blooks?\s+fine\b',
        r'\blooks?\s+correct\b',

        # Merge/close requests
        r'\bmerge\s+it\b',
        r'\bclose\s+(it|the\s+issue)\b',
        r'\bclose\s+out\s+(the\s+)?issue\b',

        # Confirmation phrases
        r'\b(yes|yep|yeah|yup),?\s*(go\s+ahead|proceed|merge|close|approve)\b',
        r'\b(go\s+ahead\s+and\s+)(merge|close|approve)\b',
        r'\bi\s+approve\b',
        r'\bchanges?\s+(are\s+)?approved?\b',
        r'\bapprove\s+(the\s+)?changes?\b',

        # Ready phrases
        r'\b(it\'?s?|that\'?s?)\s+ready\s+(to\s+)?(merge|close|go)\b',
        r'\bready\s+to\s+(merge|close|ship)\b',

        # Explicit agent invocation
        r'\b(use|invoke|run|trigger|call)\s+(the\s+)?issue[- ]?closer\b',

        # Wrap up phrases
        r'\bwrap\s+(it\s+)?up\b',
        r'\bfinish\s+(it\s+)?up\b',
        r'\blet\'?s?\s+(merge|close|finish|wrap)\b',
    ]

    for pattern in approval_patterns:
        if re.search(pattern, prompt_lower):
            return True

    return False


def find_awaiting_approval_sentinel() -> dict | None:
    """
    Find and parse an awaiting-approval sentinel file.

    Returns dict with issue context if found, None otherwise.
    """
    # Check in project's claudedocs directory
    project_dir = Path("/home/matt/projects/hapimatic")
    claudedocs_dir = project_dir / "claudedocs"

    if not claudedocs_dir.exists():
        # Also try current working directory
        claudedocs_dir = Path.cwd() / "claudedocs"

    if not claudedocs_dir.exists():
        return None

    # Look for sentinel files matching pattern
    sentinel_pattern = re.compile(r'issue-(\d+)-awaiting-approval\.md')

    for file_path in claudedocs_dir.iterdir():
        match = sentinel_pattern.match(file_path.name)
        if match:
            issue_number = match.group(1)

            # Parse sentinel file for context
            try:
                content = file_path.read_text()
                context = parse_sentinel_content(content, issue_number)
                context['sentinel_path'] = str(file_path)
                return context
            except Exception as e:
                # Return minimal context if parsing fails
                return {
                    'issue_number': issue_number,
                    'sentinel_path': str(file_path),
                    'parse_error': str(e)
                }

    return None


def parse_sentinel_content(content: str, issue_number: str) -> dict:
    """
    Parse sentinel file content to extract context.

    Returns dict with extracted fields.
    """
    context = {
        'issue_number': issue_number,
        'title': '',
        'branch': 'main',
        'complexity': 'low',
        'files_modified': [],
        'implementation_summary': '',
        'server_restart_required': False,
    }

    # Extract title
    title_match = re.search(r'Title:\s*(.+)', content)
    if title_match:
        context['title'] = title_match.group(1).strip()

    # Extract branch
    branch_match = re.search(r'Branch:\s*`?([^`\n]+)`?', content)
    if branch_match:
        context['branch'] = branch_match.group(1).strip()

    # Extract complexity
    complexity_match = re.search(r'Complexity:\s*(\w+)', content, re.IGNORECASE)
    if complexity_match:
        context['complexity'] = complexity_match.group(1).strip().lower()

    # Check for server restart requirement
    restart_match = re.search(r'Server Restart Required:\s*(Yes|No)', content, re.IGNORECASE)
    if restart_match:
        context['server_restart_required'] = restart_match.group(1).lower() == 'yes'

    # Extract files modified (look for bullet list after "Files Modified")
    files_section = re.search(
        r'## Files Modified\s*\n((?:[-*]\s*.+\n?)+)',
        content,
        re.MULTILINE
    )
    if files_section:
        files_text = files_section.group(1)
        files = re.findall(r'[-*]\s*`?([^`\n]+)`?', files_text)
        context['files_modified'] = [f.strip() for f in files if f.strip()]

    # Extract implementation summary
    summary_section = re.search(
        r'## Implementation Summary\s*\n((?:(?!##).+\n?)+)',
        content,
        re.MULTILINE
    )
    if summary_section:
        context['implementation_summary'] = summary_section.group(1).strip()

    return context


def build_closer_instructions(context: dict) -> str:
    """
    Build instructions for the issue-closer agent.
    """
    issue_number = context.get('issue_number', 'UNKNOWN')
    title = context.get('title', 'Unknown Issue')
    branch = context.get('branch', 'main')
    complexity = context.get('complexity', 'low')
    sentinel_path = context.get('sentinel_path', '')
    server_restart = context.get('server_restart_required', False)

    restart_warning = ""
    if server_restart:
        restart_warning = """
SERVER RESTART WARNING:
-----------------------
This implementation requires deploying a new binary, which will restart the
HAPImatic server and disconnect all active sessions. The issue-closer agent
MUST warn the user before deployment.
"""

    instructions = f"""
AUTOMATED TRIGGER: Issue Approval Detected
===========================================

The user has approved changes for Issue #{issue_number}. You MUST invoke the
'issue-closer' subagent via the Task tool to handle the closing workflow.

DETECTED CONTEXT:
-----------------
- Issue Number: #{issue_number}
- Title: {title}
- Branch: {branch}
- Complexity: {complexity}
- Sentinel File: {sentinel_path}
- Server Restart Required: {"Yes" if server_restart else "No"}
{restart_warning}
REQUIRED ACTION:
----------------
Invoke the issue-closer agent with:

```
Task tool:
  subagent_type: "issue-closer"
  model: "opus"
  prompt: |
    Execute the closing workflow for Issue #{issue_number}.

    1. Read the sentinel file: {sentinel_path}
    2. Execute ALL steps in order:
       - Code review (MANDATORY)
       - Git verification
       - PR creation (if on branch: {branch})
       - PR review and merge
       - Post closing summary to issue
       - Close issue
       - Cleanup (delete sentinel file)

    Return comprehensive completion report.
```

WORKFLOW REMINDERS:
-------------------
- Code review is MANDATORY - do not skip
- PR must target `main` branch
- Closing summary is MANDATORY before closing issue
- Delete sentinel file after successful close
- {"WARN BEFORE DEPLOYMENT - server restart required" if server_restart else "No server restart needed for this change"}

DO NOT proceed with any other actions until the issue-closer workflow is complete.
"""

    return instructions


def build_no_sentinel_response() -> str:
    """
    Build response when approval is detected but no sentinel file exists.
    """
    return """
ISSUE APPROVAL PATTERN DETECTED - BUT NO PENDING ISSUE FOUND
=============================================================

The user's message appears to approve changes, but no awaiting-approval
sentinel file was found in claudedocs/.

This could mean:
1. The issue-worker workflow has not yet reached the approval checkpoint
2. The sentinel file was already processed and deleted
3. The user is approving something other than an issue-worker implementation

RECOMMENDED ACTION:
-------------------
Ask the user to clarify:
- Which issue they are approving
- Whether they want to invoke the issue-closer agent manually
- If they are responding to something other than an issue-worker implementation

If the user specifies an issue number, you can manually invoke the issue-closer agent.
"""


def main():
    """
    Main hook execution.

    Reads prompt from stdin, checks for approval intent and sentinel file,
    outputs JSON to inject issue-closer instructions.
    """
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"Hook error: Invalid JSON input: {e}", file=sys.stderr)
        sys.exit(0)

    prompt = input_data.get("prompt", "")

    if detect_approval_intent(prompt):
        # Check for sentinel file
        context = find_awaiting_approval_sentinel()

        if context:
            # Found sentinel - trigger issue-closer
            instructions = build_closer_instructions(context)
        else:
            # Approval detected but no sentinel
            instructions = build_no_sentinel_response()

        output = {
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": instructions
            }
        }
        print(json.dumps(output))

    sys.exit(0)


if __name__ == "__main__":
    main()
