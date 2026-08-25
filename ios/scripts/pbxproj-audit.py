#!/usr/bin/env python3
"""Structural audit for the hand-rolled ios/Hapi.xcodeproj/project.pbxproj.

The project file is edited by hand on Linux (no Xcode to validate it), so
this script re-checks everything a bad edit could break:

  - brace / parenthesis balance (quote-aware),
  - every 24-hex UUID is defined at most once,
  - every referenced UUID has a definition, and every defined object is
    referenced from somewhere (except the root object),
  - every `isa = X;` sits inside the matching `Begin X section` block,
  - each PBXNativeTarget's buildConfigurationList / buildPhases /
    productReference references resolve to objects of the right isa.

Exit code 0 = structurally sound. Run:  python3 ios/scripts/pbxproj-audit.py
"""

import re
import sys
from collections import Counter
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "Hapi.xcodeproj" / "project.pbxproj"
text = path.read_text()
problems: list[str] = []


def balance(text: str):
    depth_b = depth_p = 0
    in_str = False
    prev = ""
    for ch in text:
        if in_str:
            if ch == '"' and prev != "\\":
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth_b += 1
            elif ch == "}":
                depth_b -= 1
            elif ch == "(":
                depth_p += 1
            elif ch == ")":
                depth_p -= 1
            if depth_b < 0 or depth_p < 0:
                return None
        prev = ch
    return depth_b, depth_p


bal = balance(text)
print(f"brace/paren balance: {bal} (expect (0, 0))")
if bal != (0, 0):
    problems.append("unbalanced delimiters")

uuids = re.findall(r"\b[A-F0-9]{24}\b", text)
counts = Counter(uuids)
defs = Counter(re.findall(r"^\t\t([A-F0-9]{24})[^=\n]*= \{", text, re.M))
print(f"distinct uuids: {len(counts)}, defined objects: {sum(defs.values())}")

for uuid, n in defs.items():
    if n > 1:
        problems.append(f"multiply-defined: {uuid} ({n}x)")

root_match = re.search(r"rootObject = ([A-F0-9]{24})", text)
root = root_match.group(1) if root_match else ""
for uuid, total in sorted(counts.items()):
    if uuid not in defs:
        problems.append(f"referenced but never defined: {uuid}")
    elif total - defs[uuid] == 0 and uuid != root:
        problems.append(f"defined but never referenced: {uuid}")

for section, body in re.findall(
    r"/\* Begin (\w+) section \*/(.*?)/\* End \1 section \*/", text, re.S
):
    for isa in re.findall(r"isa = ([\w.]+);", body):
        if isa != section:
            problems.append(f"isa {isa} inside {section} section")

# Per-object isa lookup for typed reference checks.
isa_of: dict[str, str] = {}
for match in re.finditer(
    r"^\t\t([A-F0-9]{24})[^=\n]*= \{(?:\n|.)*?isa = ([\w.]+);", text, re.M
):
    isa_of.setdefault(match.group(1), match.group(2))

for target_match in re.finditer(
    r"^\t\t([A-F0-9]{24})[^=\n]*= \{\n\t\t\tisa = PBXNativeTarget;(.*?)^\t\t\};",
    text,
    re.M | re.S,
):
    uuid, body = target_match.groups()
    expectations = {
        "buildConfigurationList": ("XCConfigurationList",),
        "productReference": ("PBXFileReference",),
    }
    for field, kinds in expectations.items():
        ref = re.search(rf"{field} = ([A-F0-9]{{24}})", body)
        if not ref:
            problems.append(f"target {uuid}: missing {field}")
        elif isa_of.get(ref.group(1)) not in kinds:
            problems.append(
                f"target {uuid}: {field} -> {ref.group(1)} has isa "
                f"{isa_of.get(ref.group(1))}, want {kinds}"
            )
    phases_block = re.search(r"buildPhases = \((.*?)\);", body, re.S)
    for phase in re.findall(r"([A-F0-9]{24})", phases_block.group(1) if phases_block else ""):
        if isa_of.get(phase) not in (
            "PBXSourcesBuildPhase",
            "PBXFrameworksBuildPhase",
            "PBXResourcesBuildPhase",
            "PBXCopyFilesBuildPhase",
            "PBXShellScriptBuildPhase",
        ):
            problems.append(f"target {uuid}: build phase {phase} has isa {isa_of.get(phase)}")

if problems:
    print("\nPROBLEMS:")
    for problem in problems:
        print(" -", problem)
    sys.exit(1)
print("\nALL CHECKS PASSED")
