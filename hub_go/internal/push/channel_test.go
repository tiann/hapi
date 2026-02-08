package push

import (
	"encoding/json"
	"testing"

	"hub_go/internal/store"
)

func TestBuildSessionPath(t *testing.T) {
	tests := []struct {
		sessionID string
		want      string
	}{
		{"abc123", "/sessions/abc123"},
		{"", "/sessions/"},
		{"session-with-dashes", "/sessions/session-with-dashes"},
	}
	for _, tt := range tests {
		got := buildSessionPath(tt.sessionID)
		if got != tt.want {
			t.Errorf("buildSessionPath(%q) = %q, want %q", tt.sessionID, got, tt.want)
		}
	}
}

func TestGetToolName_NilState(t *testing.T) {
	session := &store.Session{AgentState: nil}
	if got := getToolName(session); got != "" {
		t.Fatalf("nil state: got %q, want empty", got)
	}
}

func TestGetToolName_WrongType(t *testing.T) {
	session := &store.Session{AgentState: "not a map"}
	if got := getToolName(session); got != "" {
		t.Fatalf("wrong type: got %q, want empty", got)
	}
}

func TestGetToolName_NoRequests(t *testing.T) {
	session := &store.Session{AgentState: map[string]any{"status": "running"}}
	if got := getToolName(session); got != "" {
		t.Fatalf("no requests: got %q, want empty", got)
	}
}

func TestGetToolName_EmptyRequests(t *testing.T) {
	session := &store.Session{AgentState: map[string]any{
		"requests": map[string]any{},
	}}
	if got := getToolName(session); got != "" {
		t.Fatalf("empty requests: got %q, want empty", got)
	}
}

func TestGetToolName_WithTool(t *testing.T) {
	session := &store.Session{AgentState: map[string]any{
		"requests": map[string]any{
			"req1": map[string]any{"tool": "bash"},
		},
	}}
	if got := getToolName(session); got != "bash" {
		t.Fatalf("got %q, want bash", got)
	}
}

func TestGetToolName_MultipleRequests(t *testing.T) {
	session := &store.Session{AgentState: map[string]any{
		"requests": map[string]any{
			"bbb": map[string]any{"tool": "second"},
			"aaa": map[string]any{"tool": "first"},
		},
	}}
	// Should pick alphabetically first key ("aaa" → "first")
	if got := getToolName(session); got != "first" {
		t.Fatalf("got %q, want first (sorted by key)", got)
	}
}

func TestNotificationChannel_SendReady_NilChannel(t *testing.T) {
	var c *NotificationChannel
	err := c.SendReady(&store.Session{Active: true})
	if err != nil {
		t.Fatalf("nil channel SendReady error: %v", err)
	}
}

func TestNotificationChannel_SendReady_NilSession(t *testing.T) {
	c := &NotificationChannel{}
	err := c.SendReady(nil)
	if err != nil {
		t.Fatalf("nil session SendReady error: %v", err)
	}
}

func TestNotificationChannel_SendReady_InactiveSession(t *testing.T) {
	c := &NotificationChannel{}
	err := c.SendReady(&store.Session{Active: false})
	if err != nil {
		t.Fatalf("inactive session SendReady error: %v", err)
	}
}

func TestNotificationChannel_SendPermissionRequest_NilChannel(t *testing.T) {
	var c *NotificationChannel
	err := c.SendPermissionRequest(&store.Session{Active: true})
	if err != nil {
		t.Fatalf("nil channel SendPermissionRequest error: %v", err)
	}
}

func TestNotificationChannel_SendPermissionRequest_NilSession(t *testing.T) {
	c := &NotificationChannel{}
	err := c.SendPermissionRequest(nil)
	if err != nil {
		t.Fatalf("nil session SendPermissionRequest error: %v", err)
	}
}

func TestNotificationChannel_SendPermissionRequest_InactiveSession(t *testing.T) {
	c := &NotificationChannel{}
	err := c.SendPermissionRequest(&store.Session{Active: false})
	if err != nil {
		t.Fatalf("inactive session SendPermissionRequest error: %v", err)
	}
}

func TestNewNotificationChannel(t *testing.T) {
	c := NewNotificationChannel(nil, nil, nil)
	if c == nil {
		t.Fatal("NewNotificationChannel returned nil")
	}
}

func TestNotificationChannel_SendReady_NoPushService(t *testing.T) {
	// channel with no push service and no SSE - should succeed silently
	c := NewNotificationChannel(nil, nil, nil)
	session := &store.Session{
		ID:        "test-session",
		Active:    true,
		Namespace: "test-ns",
	}
	err := c.SendReady(session)
	if err != nil {
		t.Fatalf("SendReady with no push service error: %v", err)
	}
}

func TestNotificationChannel_SendPermissionRequest_NoPushService(t *testing.T) {
	c := NewNotificationChannel(nil, nil, nil)
	session := &store.Session{
		ID:        "test-session",
		Active:    true,
		Namespace: "test-ns",
	}
	err := c.SendPermissionRequest(session)
	if err != nil {
		t.Fatalf("SendPermissionRequest with no push service error: %v", err)
	}
}

func TestNotificationChannel_SendReady_WithAgentState(t *testing.T) {
	c := NewNotificationChannel(nil, nil, nil)
	agentState := map[string]any{
		"agentName": "TestBot",
	}
	raw, _ := json.Marshal(agentState)
	var state any
	json.Unmarshal(raw, &state)

	session := &store.Session{
		ID:         "test-session",
		Active:     true,
		Namespace:  "test-ns",
		AgentState: state,
	}
	err := c.SendReady(session)
	if err != nil {
		t.Fatalf("SendReady error: %v", err)
	}
}
