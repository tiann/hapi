package notifications

import (
	"testing"

	"hub_go/internal/store"
	"hub_go/internal/sync"
)

// ── Event Parsing ──

func TestExtractEventEnvelope_TopLevel(t *testing.T) {
	msg := map[string]any{
		"type": "event",
		"data": map[string]any{"type": "ready"},
	}
	env := extractEventEnvelope(msg)
	if env == nil {
		t.Fatal("expected non-nil envelope")
	}
	data, ok := env.Data.(map[string]any)
	if !ok || data["type"] != "ready" {
		t.Fatalf("Data = %v", env.Data)
	}
}

func TestExtractEventEnvelope_NestedContent(t *testing.T) {
	msg := map[string]any{
		"content": map[string]any{
			"type": "event",
			"data": map[string]any{"type": "permission_request"},
		},
	}
	env := extractEventEnvelope(msg)
	if env == nil {
		t.Fatal("expected non-nil envelope")
	}
}

func TestExtractEventEnvelope_NotEvent(t *testing.T) {
	msg := map[string]any{"type": "text", "data": "hello"}
	env := extractEventEnvelope(msg)
	if env != nil {
		t.Fatalf("expected nil for non-event, got %v", env)
	}
}

func TestExtractEventEnvelope_NotMap(t *testing.T) {
	env := extractEventEnvelope("not a map")
	if env != nil {
		t.Fatal("expected nil for non-map input")
	}
}

func TestExtractMessageEventType_Ready(t *testing.T) {
	event := sync.SyncEvent{
		Type: "message-received",
		Message: map[string]any{
			"content": map[string]any{
				"type": "event",
				"data": map[string]any{"type": "ready"},
			},
		},
	}
	got := extractMessageEventType(event)
	if got != "ready" {
		t.Fatalf("extractMessageEventType = %q, want ready", got)
	}
}

func TestExtractMessageEventType_NonMessage(t *testing.T) {
	event := sync.SyncEvent{Type: "session-updated"}
	if got := extractMessageEventType(event); got != "" {
		t.Fatalf("expected empty for non message-received, got %q", got)
	}
}

func TestExtractMessageEventType_NilMessage(t *testing.T) {
	event := sync.SyncEvent{Type: "message-received", Message: nil}
	if got := extractMessageEventType(event); got != "" {
		t.Fatalf("expected empty for nil message, got %q", got)
	}
}

// ── Session Info ──

func TestGetSessionName_Name(t *testing.T) {
	sess := &store.Session{
		ID:       "abcdefgh-1234",
		Metadata: map[string]any{"name": "My Task"},
	}
	if got := GetSessionName(sess); got != "My Task" {
		t.Fatalf("got %q, want 'My Task'", got)
	}
}

func TestGetSessionName_Summary(t *testing.T) {
	sess := &store.Session{
		ID: "abcdefgh-1234",
		Metadata: map[string]any{
			"summary": map[string]any{"text": "Fix bug"},
		},
	}
	if got := GetSessionName(sess); got != "Fix bug" {
		t.Fatalf("got %q, want 'Fix bug'", got)
	}
}

func TestGetSessionName_Path(t *testing.T) {
	sess := &store.Session{
		ID:       "abcdefgh-1234",
		Metadata: map[string]any{"path": "/home/user/project"},
	}
	if got := GetSessionName(sess); got != "project" {
		t.Fatalf("got %q, want 'project'", got)
	}
}

func TestGetSessionName_FallbackID(t *testing.T) {
	sess := &store.Session{ID: "abcdefgh-1234"}
	if got := GetSessionName(sess); got != "abcdefgh" {
		t.Fatalf("got %q, want 'abcdefgh'", got)
	}
}

func TestGetSessionName_Nil(t *testing.T) {
	if got := GetSessionName(nil); got != "" {
		t.Fatalf("got %q, want empty", got)
	}
}

func TestGetAgentName(t *testing.T) {
	tests := []struct {
		flavor string
		want   string
	}{
		{"claude", "Claude"},
		{"gemini", "Gemini"},
		{"codex", "Codex"},
		{"opencode", "OpenCode"},
		{"unknown", "Agent"},
		{"", "Agent"},
	}
	for _, tt := range tests {
		t.Run(tt.flavor, func(t *testing.T) {
			sess := &store.Session{Metadata: map[string]any{"flavor": tt.flavor}}
			if tt.flavor == "" {
				sess = &store.Session{}
			}
			got := GetAgentName(sess)
			if got != tt.want {
				t.Fatalf("GetAgentName(%q) = %q, want %q", tt.flavor, got, tt.want)
			}
		})
	}
}

func TestGetAgentName_Nil(t *testing.T) {
	if got := GetAgentName(nil); got != "Agent" {
		t.Fatalf("got %q, want Agent", got)
	}
}
