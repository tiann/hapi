package httpserver

import (
	"testing"

	"hub_go/internal/store"
)

func TestParseBool(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		{"true", true},
		{"1", true},
		{"false", false},
		{"0", false},
		{"", false},
		{"yes", false},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			if got := parseBool(tt.input); got != tt.want {
				t.Fatalf("parseBool(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

func TestEstimateBase64Bytes(t *testing.T) {
	tests := []struct {
		input string
		want  int
	}{
		{"", 0},
		{"AAAA", 3},       // 4 chars = 3 bytes
		{"AAAA==", 2},     // 6 chars, 2 padding = 2 bytes
		{"AAAAAA==", 4},   // 8 chars, 2 padding = 4 bytes
		{"AAAAAAA=", 5},   // 8 chars, 1 padding = 5 bytes
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			if got := estimateBase64Bytes(tt.input); got != tt.want {
				t.Fatalf("estimateBase64Bytes(%q) = %d, want %d", tt.input, got, tt.want)
			}
		})
	}
}

func TestToStringSlice(t *testing.T) {
	got := toStringSlice([]any{"a", "b", "c"})
	if len(got) != 3 || got[0] != "a" {
		t.Fatalf("got %v", got)
	}

	// non-strings are skipped
	got2 := toStringSlice([]any{"a", 42, "b"})
	if len(got2) != 2 {
		t.Fatalf("got %v", got2)
	}

	// non-slice returns nil
	if got3 := toStringSlice("not a slice"); got3 != nil {
		t.Fatalf("got %v", got3)
	}
}

func TestUniqueStrings(t *testing.T) {
	got := uniqueStrings([]string{"a", "b", "a", "c", "b"})
	if len(got) != 3 {
		t.Fatalf("got %v, want 3 elements", got)
	}

	// empty strings and whitespace are trimmed
	got2 := uniqueStrings([]string{" a ", "a", ""})
	if len(got2) != 1 || got2[0] != "a" {
		t.Fatalf("got %v", got2)
	}

	// nil/empty
	if got3 := uniqueStrings(nil); got3 != nil {
		t.Fatalf("got %v", got3)
	}
}

func TestAttachmentsEmpty(t *testing.T) {
	if !attachmentsEmpty(nil) {
		t.Fatal("nil should be empty")
	}
	if !attachmentsEmpty([]any{}) {
		t.Fatal("empty slice should be empty")
	}
	if attachmentsEmpty([]any{"file.txt"}) {
		t.Fatal("non-empty slice should not be empty")
	}
	if attachmentsEmpty("not a slice") {
		t.Fatal("non-slice should return false")
	}
}

func TestCountPendingRequests(t *testing.T) {
	if got := countPendingRequests(nil); got != 0 {
		t.Fatalf("nil = %d", got)
	}
	if got := countPendingRequests("not a map"); got != 0 {
		t.Fatalf("string = %d", got)
	}

	state := map[string]any{
		"requests": map[string]any{
			"req1": map[string]any{"tool": "Bash"},
			"req2": map[string]any{"tool": "Write"},
		},
	}
	if got := countPendingRequests(state); got != 2 {
		t.Fatalf("got %d, want 2", got)
	}
}

func TestComputeTodoProgress(t *testing.T) {
	// nil
	if got := computeTodoProgress(nil); got != nil {
		t.Fatalf("nil = %v", got)
	}

	// empty
	if got := computeTodoProgress([]any{}); got != nil {
		t.Fatalf("empty = %v", got)
	}

	// valid todos
	todos := []any{
		map[string]any{"status": "completed", "text": "done"},
		map[string]any{"status": "pending", "text": "wip"},
		map[string]any{"status": "completed", "text": "also done"},
	}
	got := computeTodoProgress(todos)
	progress, ok := got.(map[string]any)
	if !ok {
		t.Fatalf("got %v", got)
	}
	if progress["completed"] != 2 || progress["total"] != 3 {
		t.Fatalf("got %v", progress)
	}

	// entries without status are skipped
	todos2 := []any{
		map[string]any{"text": "no status"},
		map[string]any{"status": "pending", "text": "has status"},
	}
	got2 := computeTodoProgress(todos2)
	progress2, _ := got2.(map[string]any)
	if progress2["total"] != 1 {
		t.Fatalf("got %v", progress2)
	}
}

func TestNullableStringToValue(t *testing.T) {
	if got := nullableStringToValue(""); got != nil {
		t.Fatalf("empty = %v", got)
	}
	if got := nullableStringToValue("hello"); got != "hello" {
		t.Fatalf("got %v", got)
	}
}

func TestHasPendingRequest(t *testing.T) {
	session := &store.Session{
		AgentState: map[string]any{
			"requests": map[string]any{
				"req-123": map[string]any{"tool": "Bash"},
			},
		},
	}
	if !hasPendingRequest(session, "req-123") {
		t.Fatal("should find req-123")
	}
	if hasPendingRequest(session, "nonexistent") {
		t.Fatal("should not find nonexistent")
	}
	if hasPendingRequest(nil, "req-123") {
		t.Fatal("nil session should return false")
	}
	if hasPendingRequest(session, "") {
		t.Fatal("empty requestID should return false")
	}
}

func TestSelectResumeMachine(t *testing.T) {
	machines := []store.Machine{
		{ID: "m1", Active: false},
		{ID: "m2", Active: true, Metadata: map[string]any{"host": "dev-box"}},
		{ID: "m3", Active: true},
	}

	// no machines
	if got := selectResumeMachine(nil, nil); got != nil {
		t.Fatalf("nil = %v", got)
	}

	// no online machines
	if got := selectResumeMachine([]store.Machine{{ID: "m1", Active: false}}, nil); got != nil {
		t.Fatalf("no online = %v", got)
	}

	// by machineId
	got := selectResumeMachine(machines, map[string]any{"machineId": "m3"})
	if got == nil || got.ID != "m3" {
		t.Fatalf("by machineId = %v", got)
	}

	// by host
	got2 := selectResumeMachine(machines, map[string]any{"host": "dev-box"})
	if got2 == nil || got2.ID != "m2" {
		t.Fatalf("by host = %v", got2)
	}

	// fallback to first online
	got3 := selectResumeMachine(machines, nil)
	if got3 == nil || got3.ID != "m2" {
		t.Fatalf("fallback = %v", got3)
	}
}

func TestGetMetadataString(t *testing.T) {
	meta := map[string]any{"name": "test", "empty": ""}
	if got := getMetadataString(meta, "name", "default"); got != "test" {
		t.Fatalf("got %q", got)
	}
	if got := getMetadataString(meta, "missing", "default"); got != "default" {
		t.Fatalf("got %q", got)
	}
	if got := getMetadataString(meta, "empty", "default"); got != "default" {
		t.Fatalf("empty should use fallback, got %q", got)
	}
	if got := getMetadataString("not a map", "key", "default"); got != "default" {
		t.Fatalf("non-map should use fallback, got %q", got)
	}
}
