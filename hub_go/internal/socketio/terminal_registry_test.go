package socketio

import (
	"testing"
	"time"
)

func TestTerminalRegistry_Register(t *testing.T) {
	r := NewTerminalRegistry(2, 2, 15*time.Minute, nil)
	conn := &wsConn{}

	entry, reason := r.Register("t1", "s1", "sock1", conn)
	if entry == nil || reason != "" {
		t.Fatalf("expected success, got reason=%q", reason)
	}
	if entry.TerminalID != "t1" || entry.SessionID != "s1" || entry.SocketID != "sock1" {
		t.Fatalf("unexpected entry: %+v", entry)
	}
}

func TestTerminalRegistry_DuplicateID(t *testing.T) {
	r := NewTerminalRegistry(2, 2, 15*time.Minute, nil)
	conn := &wsConn{}

	r.Register("t1", "s1", "sock1", conn)
	_, reason := r.Register("t1", "s1", "sock1", conn)
	if reason != "in_use" {
		t.Fatalf("expected in_use, got %q", reason)
	}
}

func TestTerminalRegistry_MaxPerSocket(t *testing.T) {
	r := NewTerminalRegistry(2, 10, 15*time.Minute, nil)
	conn := &wsConn{}

	r.Register("t1", "s1", "sock1", conn)
	r.Register("t2", "s1", "sock1", conn)
	_, reason := r.Register("t3", "s1", "sock1", conn)
	if reason != "too_many_socket" {
		t.Fatalf("expected too_many_socket, got %q", reason)
	}
}

func TestTerminalRegistry_MaxPerSession(t *testing.T) {
	r := NewTerminalRegistry(10, 2, 15*time.Minute, nil)
	conn := &wsConn{}

	r.Register("t1", "s1", "sock1", conn)
	r.Register("t2", "s1", "sock2", conn)
	_, reason := r.Register("t3", "s1", "sock3", conn)
	if reason != "too_many_session" {
		t.Fatalf("expected too_many_session, got %q", reason)
	}
}

func TestTerminalRegistry_InvalidArgs(t *testing.T) {
	r := NewTerminalRegistry(2, 2, 15*time.Minute, nil)
	conn := &wsConn{}

	_, reason := r.Register("", "s1", "sock1", conn)
	if reason != "invalid" {
		t.Fatalf("expected invalid for empty terminalID, got %q", reason)
	}
	_, reason = r.Register("t1", "", "sock1", conn)
	if reason != "invalid" {
		t.Fatalf("expected invalid for empty sessionID, got %q", reason)
	}
	_, reason = r.Register("t1", "s1", "", conn)
	if reason != "invalid" {
		t.Fatalf("expected invalid for empty socketID, got %q", reason)
	}
	_, reason = r.Register("t1", "s1", "sock1", nil)
	if reason != "invalid" {
		t.Fatalf("expected invalid for nil conn, got %q", reason)
	}
}

func TestTerminalRegistry_Get(t *testing.T) {
	r := NewTerminalRegistry(2, 2, 15*time.Minute, nil)
	conn := &wsConn{}

	r.Register("t1", "s1", "sock1", conn)

	entry := r.Get("t1")
	if entry == nil || entry.TerminalID != "t1" {
		t.Fatalf("expected t1, got %v", entry)
	}

	if r.Get("nonexistent") != nil {
		t.Fatal("expected nil for nonexistent")
	}
}

func TestTerminalRegistry_Remove(t *testing.T) {
	r := NewTerminalRegistry(2, 2, 15*time.Minute, nil)
	conn := &wsConn{}

	r.Register("t1", "s1", "sock1", conn)
	removed := r.Remove("t1")
	if removed == nil || removed.TerminalID != "t1" {
		t.Fatalf("expected t1, got %v", removed)
	}

	if r.Get("t1") != nil {
		t.Fatal("expected nil after remove")
	}
	if r.CountForSocket("sock1") != 0 {
		t.Fatal("socket count should be 0")
	}
	if r.CountForSession("s1") != 0 {
		t.Fatal("session count should be 0")
	}
}

func TestTerminalRegistry_RemoveBySocket(t *testing.T) {
	r := NewTerminalRegistry(4, 4, 15*time.Minute, nil)
	conn := &wsConn{}

	r.Register("t1", "s1", "sock1", conn)
	r.Register("t2", "s1", "sock1", conn)
	r.Register("t3", "s2", "sock2", conn)

	removed := r.RemoveBySocket("sock1")
	if len(removed) != 2 {
		t.Fatalf("expected 2 removed, got %d", len(removed))
	}
	if r.CountForSocket("sock1") != 0 {
		t.Fatal("socket count should be 0")
	}
	if r.Get("t3") == nil {
		t.Fatal("t3 should remain")
	}
}

func TestTerminalRegistry_RemoveByCliConn(t *testing.T) {
	r := NewTerminalRegistry(4, 4, 15*time.Minute, nil)
	conn1 := &wsConn{}
	conn2 := &wsConn{}

	r.Register("t1", "s1", "sock1", conn1)
	r.Register("t2", "s1", "sock2", conn2)

	removed := r.RemoveByCliConn(conn1)
	if len(removed) != 1 || removed[0].TerminalID != "t1" {
		t.Fatalf("expected [t1], got %v", removed)
	}
	if r.Get("t2") == nil {
		t.Fatal("t2 should remain")
	}
}

func TestTerminalRegistry_CountForSocket(t *testing.T) {
	r := NewTerminalRegistry(4, 4, 15*time.Minute, nil)
	conn := &wsConn{}

	if r.CountForSocket("sock1") != 0 {
		t.Fatal("expected 0 for empty")
	}
	r.Register("t1", "s1", "sock1", conn)
	if r.CountForSocket("sock1") != 1 {
		t.Fatal("expected 1")
	}
}

func TestTerminalRegistry_MarkActivity(t *testing.T) {
	r := NewTerminalRegistry(2, 2, 15*time.Minute, nil)
	conn := &wsConn{}

	r.Register("t1", "s1", "sock1", conn)
	before := r.Get("t1").LastSeen

	time.Sleep(2 * time.Millisecond)
	r.MarkActivity("t1")

	after := r.Get("t1").LastSeen
	if !after.After(before) {
		t.Fatal("LastSeen should be updated")
	}
}

func TestTerminalRegistry_ExpireIdle(t *testing.T) {
	var expired []terminalEntry
	r := NewTerminalRegistry(4, 4, 10*time.Millisecond, func(entry terminalEntry) {
		expired = append(expired, entry)
	})
	conn := &wsConn{}

	r.Register("t1", "s1", "sock1", conn)

	// Set LastSeen to past
	r.mu.Lock()
	r.byTerminalID["t1"].LastSeen = time.Now().Add(-1 * time.Second)
	r.mu.Unlock()

	r.expireIdle()

	if len(expired) != 1 || expired[0].TerminalID != "t1" {
		t.Fatalf("expected [t1] expired, got %v", expired)
	}
	if r.Get("t1") != nil {
		t.Fatal("t1 should be removed after expiry")
	}
}

func TestTerminalRegistry_NilReceiver(t *testing.T) {
	var r *TerminalRegistry

	// All methods should handle nil gracefully
	r.MarkActivity("t1")
	r.StopIdleLoop()
	r.StartIdleLoop(time.Second)
	if r.Get("t1") != nil {
		t.Fatal("expected nil")
	}
	if r.CountForSocket("s") != 0 {
		t.Fatal("expected 0")
	}
	if r.CountForSession("s") != 0 {
		t.Fatal("expected 0")
	}
	if r.Remove("t") != nil {
		t.Fatal("expected nil")
	}
	if r.RemoveBySocket("s") != nil {
		t.Fatal("expected nil")
	}
	if r.RemoveByCliConn(nil) != nil {
		t.Fatal("expected nil")
	}
}
