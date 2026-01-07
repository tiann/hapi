# Issue #12 Analysis: Jump to Bottom Button

## Summary

Add a floating "Jump to Bottom" button that appears when users scroll up in the chat interface.

## Findings

### Existing Infrastructure (Good News!)

The `HappyThread.tsx` component **already has most of the infrastructure**:

| Feature | Status | Location |
|---------|--------|----------|
| Scroll position tracking | ✅ Exists | Lines 96-116 |
| "At bottom" threshold (120px) | ✅ Exists | Line 100 |
| `autoScrollEnabled` state | ✅ Exists | Line 80 |
| `scrollToBottom()` function | ✅ Exists | Lines 156-163 |
| New messages indicator | ✅ Exists | Lines 12-25 |

### The Gap

The current `NewMessagesIndicator` **only appears when there are new messages**:

```tsx
function NewMessagesIndicator(props: { count: number; onClick: () => void }) {
    if (props.count === 0) {
        return null  // <-- Hidden when no new messages
    }
    // ...renders button
}
```

**Issue #12 wants**: A button that appears **whenever** the user scrolls up, not just when new messages arrive.

## Implementation Plan

### Option A: Enhance Existing Component (Recommended)

Modify `NewMessagesIndicator` to show even when count is 0, but with different styling:
- **With new messages**: "5 new messages ↓" (current behavior)
- **Without new messages**: Just "↓" icon button

This is the simplest approach with minimal code changes.

### Option B: Separate Component

Create a new `JumpToBottomButton` component that:
- Shows when `!autoScrollEnabled`
- Optionally displays new message count as a badge
- Positioned bottom-right of chat area

### Changes Required (Option A)

**File:** `web/src/components/AssistantChat/HappyThread.tsx`

1. **Update NewMessagesIndicator** to accept `showAlways` prop or check if scrolled up
2. **Modify return condition** to show button when scrolled up (count > 0 OR !autoScrollEnabled)
3. **Conditional rendering**: Show count when > 0, show just arrow when scrolled up without new messages

### Proposed Component Update

```tsx
function JumpToBottomIndicator(props: {
    count: number
    showButton: boolean  // true when scrolled up
    onClick: () => void
}) {
    if (!props.showButton && props.count === 0) {
        return null
    }

    return (
        <button
            onClick={props.onClick}
            className="absolute bottom-20 left-1/2 -translate-x-1/2 bg-[var(--app-button)] text-[var(--app-button-text)] px-3 py-1.5 rounded-full text-sm font-medium shadow-lg animate-bounce-in z-10"
            aria-label={props.count > 0 ? `${props.count} new messages, jump to bottom` : 'Jump to bottom'}
        >
            {props.count > 0 ? (
                <>{props.count} new message{props.count > 1 ? 's' : ''} &#8595;</>
            ) : (
                <>&#8595;</>
            )}
        </button>
    )
}
```

### Usage Update

```tsx
// Current
<NewMessagesIndicator count={newMessageCount} onClick={scrollToBottom} />

// New
<JumpToBottomIndicator
    count={newMessageCount}
    showButton={!autoScrollEnabled}
    onClick={scrollToBottom}
/>
```

## Acceptance Criteria Mapping

| Criterion | Implementation |
|-----------|----------------|
| Button appears when scrolled up | Pass `!autoScrollEnabled` as `showButton` prop |
| Button hidden at bottom | `showButton` is false when autoScrollEnabled |
| Smooth scroll on click | Already implemented in `scrollToBottom()` |
| Consistent styling | Use existing CSS variables |
| Accessible | Add aria-label for screen readers |
| Mobile-friendly | Button already has touch-friendly size |
| No performance impact | Reuses existing scroll handler |

## Complexity Assessment

**Low complexity** - Minor enhancement to existing component

- Reuses existing scroll tracking infrastructure
- No new dependencies
- Single file change
- No server restart required

## Testing Plan

1. TypeCheck: `bun run typecheck`
2. Build: `bun run build:single-exe`
3. Deploy and verify via Playwright:
   - Navigate to a session with messages
   - Scroll up - verify button appears
   - Click button - verify smooth scroll to bottom
   - At bottom - verify button disappears
