/**
 * The line-number cells use `px-3`, so their grid track must include both
 * horizontal padding edges or a three-digit line number can crowd the code.
 * Keep this calculation shared by CodeBlock and Markdown's highlighter.
 */
const CODE_GUTTER_HORIZONTAL_PADDING_REM = 1.5

export function getCodeGutterTrack(lineNumberWidth: number): string {
    return `calc(${lineNumberWidth}ch + ${CODE_GUTTER_HORIZONTAL_PADDING_REM}rem)`
}
