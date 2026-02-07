package sync

import "testing"

func TestValidPriority(t *testing.T) {
	for _, v := range []string{"high", "medium", "low"} {
		if !validPriority(v) {
			t.Fatalf("validPriority(%q) = false", v)
		}
	}
	for _, v := range []string{"", "critical", "HIGH", "none"} {
		if validPriority(v) {
			t.Fatalf("validPriority(%q) = true", v)
		}
	}
}

func TestValidStatus(t *testing.T) {
	for _, v := range []string{"pending", "in_progress", "completed"} {
		if !validStatus(v) {
			t.Fatalf("validStatus(%q) = false", v)
		}
	}
	for _, v := range []string{"", "done", "PENDING", "cancelled"} {
		if validStatus(v) {
			t.Fatalf("validStatus(%q) = true", v)
		}
	}
}

func TestItoa(t *testing.T) {
	tests := []struct {
		input int
		want  string
	}{
		{0, "0"},
		{1, "1"},
		{42, "42"},
		{100, "100"},
		{999999, "999999"},
	}
	for _, tt := range tests {
		if got := itoa(tt.input); got != tt.want {
			t.Fatalf("itoa(%d) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestValidateTodos_Valid(t *testing.T) {
	input := []any{
		map[string]any{"content": "Fix bug", "priority": "high", "status": "pending", "id": "t1"},
		map[string]any{"content": "Add test", "priority": "low", "status": "completed", "id": "t2"},
	}
	got := validateTodos(input)
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if got[0]["content"] != "Fix bug" || got[0]["id"] != "t1" {
		t.Fatalf("first todo = %v", got[0])
	}
}

func TestValidateTodos_AutoID(t *testing.T) {
	input := []any{
		map[string]any{"content": "No ID todo", "priority": "medium", "status": "pending"},
	}
	got := validateTodos(input)
	if len(got) != 1 {
		t.Fatalf("len = %d", len(got))
	}
	if got[0]["id"] != "No-ID-todo" {
		t.Fatalf("auto-id = %q, want No-ID-todo", got[0]["id"])
	}
}

func TestValidateTodos_SkipsInvalid(t *testing.T) {
	input := []any{
		map[string]any{"content": "", "priority": "high", "status": "pending"},       // empty content
		map[string]any{"content": "X", "priority": "wrong", "status": "pending"},     // bad priority
		map[string]any{"content": "X", "priority": "high", "status": "bad"},          // bad status
		"not a map",                                                                   // wrong type
		map[string]any{"content": "Good", "priority": "high", "status": "completed"}, // valid
	}
	got := validateTodos(input)
	if len(got) != 1 || got[0]["content"] != "Good" {
		t.Fatalf("got %v", got)
	}
}

func TestValidateTodos_Nil(t *testing.T) {
	if got := validateTodos(nil); got != nil {
		t.Fatalf("nil = %v", got)
	}
	if got := validateTodos([]any{}); got != nil {
		t.Fatalf("empty = %v", got)
	}
	if got := validateTodos("not a slice"); got != nil {
		t.Fatalf("string = %v", got)
	}
}

func TestIsRoleWrappedRecord(t *testing.T) {
	if !isRoleWrappedRecord(map[string]any{"role": "agent", "content": "x"}) {
		t.Fatal("should be true for role+content")
	}
	if isRoleWrappedRecord(map[string]any{"content": "x"}) {
		t.Fatal("should be false without role")
	}
	if isRoleWrappedRecord(map[string]any{"role": "", "content": "x"}) {
		t.Fatal("should be false for empty role")
	}
	if isRoleWrappedRecord(map[string]any{"role": "agent"}) {
		t.Fatal("should be false without content")
	}
}

func TestUnwrapRoleWrappedRecordEnvelope(t *testing.T) {
	// direct role-wrapped record
	direct := map[string]any{"role": "agent", "content": "x"}
	got, ok := unwrapRoleWrappedRecordEnvelope(direct)
	if !ok || got["role"] != "agent" {
		t.Fatalf("direct = %v, %v", got, ok)
	}

	// nested via "message"
	nested := map[string]any{"message": map[string]any{"role": "assistant", "content": "y"}}
	got, ok = unwrapRoleWrappedRecordEnvelope(nested)
	if !ok || got["role"] != "assistant" {
		t.Fatalf("message = %v, %v", got, ok)
	}

	// nested via "data" -> "message"
	deep := map[string]any{"data": map[string]any{"message": map[string]any{"role": "agent", "content": "z"}}}
	got, ok = unwrapRoleWrappedRecordEnvelope(deep)
	if !ok || got["role"] != "agent" {
		t.Fatalf("data.message = %v, %v", got, ok)
	}

	// nested via "payload" -> "message"
	payload := map[string]any{"payload": map[string]any{"message": map[string]any{"role": "agent", "content": "w"}}}
	got, ok = unwrapRoleWrappedRecordEnvelope(payload)
	if !ok || got["role"] != "agent" {
		t.Fatalf("payload.message = %v, %v", got, ok)
	}

	// non-map
	_, ok = unwrapRoleWrappedRecordEnvelope("string")
	if ok {
		t.Fatal("string should fail")
	}

	// map without role
	_, ok = unwrapRoleWrappedRecordEnvelope(map[string]any{"foo": "bar"})
	if ok {
		t.Fatal("no role should fail")
	}
}

func TestExtractTodosFromClaudeOutput(t *testing.T) {
	content := map[string]any{
		"type": "output",
		"data": map[string]any{
			"type": "assistant",
			"message": map[string]any{
				"content": []any{
					map[string]any{
						"type":  "tool_use",
						"name":  "TodoWrite",
						"input": map[string]any{"todos": []any{map[string]any{"content": "task1", "priority": "high", "status": "pending", "id": "1"}}},
					},
				},
			},
		},
	}
	got := extractTodosFromClaudeOutput(content)
	if len(got) != 1 || got[0]["content"] != "task1" {
		t.Fatalf("got %v", got)
	}

	// wrong type
	if got := extractTodosFromClaudeOutput(map[string]any{"type": "not-output"}); got != nil {
		t.Fatalf("wrong type = %v", got)
	}
}

func TestExtractTodosFromCodexMessage(t *testing.T) {
	content := map[string]any{
		"type": "codex",
		"data": map[string]any{
			"type":  "tool-call",
			"name":  "TodoWrite",
			"input": map[string]any{"todos": []any{map[string]any{"content": "codex task", "priority": "low", "status": "completed", "id": "c1"}}},
		},
	}
	got := extractTodosFromCodexMessage(content)
	if len(got) != 1 || got[0]["content"] != "codex task" {
		t.Fatalf("got %v", got)
	}

	// wrong name
	noMatch := map[string]any{
		"type": "codex",
		"data": map[string]any{"type": "tool-call", "name": "OtherTool", "input": map[string]any{}},
	}
	if got := extractTodosFromCodexMessage(noMatch); got != nil {
		t.Fatalf("wrong name = %v", got)
	}
}

func TestExtractTodosFromAcpMessage(t *testing.T) {
	content := map[string]any{
		"type": "codex",
		"data": map[string]any{
			"type": "plan",
			"entries": []any{
				map[string]any{"content": "step 1", "priority": "high", "status": "pending", "id": "p1"},
				map[string]any{"content": "step 2", "priority": "medium", "status": "in_progress"},
			},
		},
	}
	got := extractTodosFromAcpMessage(content)
	if len(got) != 2 {
		t.Fatalf("len = %d", len(got))
	}
	if got[0]["id"] != "p1" {
		t.Fatalf("first id = %q", got[0]["id"])
	}
	// auto-generated id for second entry (index=1, so "plan-2")
	if got[1]["id"] != "plan-2" {
		t.Fatalf("second auto id = %q, want plan-2", got[1]["id"])
	}

	// empty entries
	empty := map[string]any{"type": "codex", "data": map[string]any{"type": "plan", "entries": []any{}}}
	if got := extractTodosFromAcpMessage(empty); got != nil {
		t.Fatalf("empty entries = %v", got)
	}
}

func TestExtractTodoWriteTodosFromMessageContent(t *testing.T) {
	// Claude output format
	msg := map[string]any{
		"role": "agent",
		"content": map[string]any{
			"type": "output",
			"data": map[string]any{
				"type": "assistant",
				"message": map[string]any{
					"content": []any{
						map[string]any{
							"type":  "tool_use",
							"name":  "TodoWrite",
							"input": map[string]any{"todos": []any{map[string]any{"content": "full test", "priority": "high", "status": "pending", "id": "ft1"}}},
						},
					},
				},
			},
		},
	}
	got := ExtractTodoWriteTodosFromMessageContent(msg)
	if len(got) != 1 || got[0]["id"] != "ft1" {
		t.Fatalf("got %v", got)
	}

	// non-agent role
	userMsg := map[string]any{"role": "user", "content": map[string]any{"type": "output"}}
	if got := ExtractTodoWriteTodosFromMessageContent(userMsg); got != nil {
		t.Fatalf("user role = %v", got)
	}

	// not a map
	if got := ExtractTodoWriteTodosFromMessageContent("string"); got != nil {
		t.Fatalf("string = %v", got)
	}

	// nested via data.message wrapper
	wrapped := map[string]any{
		"data": map[string]any{
			"message": map[string]any{
				"role": "assistant",
				"content": map[string]any{
					"type": "codex",
					"data": map[string]any{
						"type":  "tool-call",
						"name":  "TodoWrite",
						"input": map[string]any{"todos": []any{map[string]any{"content": "wrapped", "priority": "low", "status": "completed", "id": "w1"}}},
					},
				},
			},
		},
	}
	got2 := ExtractTodoWriteTodosFromMessageContent(wrapped)
	if len(got2) != 1 || got2[0]["id"] != "w1" {
		t.Fatalf("wrapped = %v", got2)
	}
}
