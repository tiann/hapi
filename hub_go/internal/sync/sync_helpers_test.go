package sync

import (
	"testing"
	"time"

	"hub_go/internal/sse"
	"hub_go/internal/store"
)

// ── Event Helpers ──

func TestSessionEventData(t *testing.T) {
	session := &store.Session{
		ID:              "sess-1",
		Namespace:       "ns",
		Seq:             5,
		Active:          true,
		PermissionMode:  "auto",
		ModelMode:       "",
		Metadata:        map[string]any{"name": "test"},
		MetadataVersion: 2,
	}
	got := SessionEventData(session)
	if got["id"] != "sess-1" || got["namespace"] != "ns" || got["seq"] != int64(5) {
		t.Fatalf("basic fields: %v", got)
	}
	if got["active"] != true {
		t.Fatalf("active = %v", got["active"])
	}
	if got["permissionMode"] != "auto" {
		t.Fatalf("permissionMode = %v", got["permissionMode"])
	}
	// empty modelMode should be nil via nullIfEmpty
	if got["modelMode"] != nil {
		t.Fatalf("modelMode = %v, want nil", got["modelMode"])
	}
}

func TestSessionEventData_Nil(t *testing.T) {
	got := SessionEventData(nil)
	if len(got) != 0 {
		t.Fatalf("nil session = %v", got)
	}
}

func TestMachineEventData(t *testing.T) {
	machine := &store.Machine{
		ID:        "m-1",
		Namespace: "ns",
		Active:    true,
		Seq:       3,
	}
	got := MachineEventData(machine)
	if got["id"] != "m-1" || got["active"] != true || got["seq"] != int64(3) {
		t.Fatalf("got %v", got)
	}
}

func TestMachineEventData_Nil(t *testing.T) {
	got := MachineEventData(nil)
	if len(got) != 0 {
		t.Fatalf("nil machine = %v", got)
	}
}

func TestMessageEventData(t *testing.T) {
	msg := store.Message{
		ID:      "msg-1",
		Seq:     10,
		Content: map[string]any{"text": "hello"},
		LocalID: "local-1",
	}
	got := MessageEventData(msg)
	if got["id"] != "msg-1" || got["seq"] != int64(10) {
		t.Fatalf("basic fields: %v", got)
	}
	if got["localId"] != "local-1" {
		t.Fatalf("localId = %v", got["localId"])
	}

	// empty LocalID -> nil
	msg2 := store.Message{ID: "msg-2", Seq: 1}
	got2 := MessageEventData(msg2)
	if got2["localId"] != nil {
		t.Fatalf("empty localId = %v, want nil", got2["localId"])
	}
}

// ── Session Cache Helpers ──

func TestMaxInt64(t *testing.T) {
	if got := maxInt64(1, 2); got != 2 {
		t.Fatalf("maxInt64(1,2) = %d", got)
	}
	if got := maxInt64(5, 3); got != 5 {
		t.Fatalf("maxInt64(5,3) = %d", got)
	}
	if got := maxInt64(7, 7); got != 7 {
		t.Fatalf("maxInt64(7,7) = %d", got)
	}
}

func TestNullIfEmpty(t *testing.T) {
	if got := nullIfEmpty(""); got != nil {
		t.Fatalf("empty = %v", got)
	}
	if got := nullIfEmpty("hello"); got != "hello" {
		t.Fatalf("non-empty = %v", got)
	}
}

func TestClampAliveTime(t *testing.T) {
	// zero/negative -> 0
	if got := clampAliveTime(0); got != 0 {
		t.Fatalf("zero = %d", got)
	}
	if got := clampAliveTime(-1); got != 0 {
		t.Fatalf("negative = %d", got)
	}

	// current time -> same value
	now := time.Now().UnixMilli()
	if got := clampAliveTime(now); got != now {
		t.Fatalf("current = %d, want %d", got, now)
	}

	// far future (>60s ahead) -> 0
	future := time.Now().UnixMilli() + 120_000
	if got := clampAliveTime(future); got != 0 {
		t.Fatalf("far future = %d, want 0", got)
	}

	// far past (>60s ago) -> 0
	past := time.Now().UnixMilli() - 120_000
	if got := clampAliveTime(past); got != 0 {
		t.Fatalf("far past = %d, want 0", got)
	}
}

// ── Event Publisher Helper ──

func TestToSSEEvent(t *testing.T) {
	event := SyncEvent{
		Type:      "session-updated",
		Namespace: "ns1",
		SessionID: "s1",
		Data:      map[string]any{"key": "val"},
	}
	got := toSSEEvent(event)
	if got.Type != "session-updated" {
		t.Fatalf("Type = %q", got.Type)
	}
	if got.Data["namespace"] != "ns1" {
		t.Fatalf("namespace = %v", got.Data["namespace"])
	}
	if got.Data["sessionId"] != "s1" {
		t.Fatalf("sessionId = %v", got.Data["sessionId"])
	}
	if got.Data["data"] == nil {
		t.Fatal("data should be set")
	}
}

func TestToSSEEvent_Minimal(t *testing.T) {
	event := SyncEvent{Type: "ping"}
	got := toSSEEvent(event)
	if got.Type != "ping" {
		t.Fatalf("Type = %q", got.Type)
	}
	if _, exists := got.Data["namespace"]; exists {
		t.Fatal("namespace should not be set")
	}
	if _, exists := got.Data["sessionId"]; exists {
		t.Fatal("sessionId should not be set")
	}
}

func TestToSSEEvent_WithMessage(t *testing.T) {
	event := SyncEvent{
		Type:    "message-received",
		Message: map[string]any{"id": "m1"},
	}
	got := toSSEEvent(event)
	if got.Data["message"] == nil {
		t.Fatal("message should be set")
	}
	msg := got.Data["message"].(map[string]any)
	if msg["id"] != "m1" {
		t.Fatalf("message.id = %v", msg["id"])
	}
}

// verify sse.Event structure
var _ sse.Event = toSSEEvent(SyncEvent{})
