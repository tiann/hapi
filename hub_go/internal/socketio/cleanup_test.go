package socketio

import (
	"testing"
	"time"
)

func TestServer_CleanupExpiredSessions(t *testing.T) {
	srv := &Server{
		sessions: make(map[string]*Session),
		outbox:   NewOutbox(),
		stopCh:   make(chan struct{}),
	}

	now := time.Now()
	expired := now.Add(-time.Duration(engineIdleTimeoutMs+1000) * time.Millisecond)
	recent := now.Add(-10 * time.Second)

	srv.sessions["expired1"] = &Session{
		SID:      "expired1",
		LastSeen: expired,
	}
	srv.sessions["active1"] = &Session{
		SID:      "active1",
		LastSeen: recent,
	}
	srv.sessions["zero-time"] = &Session{
		SID: "zero-time",
	}

	srv.cleanupExpiredSessions()

	if _, ok := srv.sessions["expired1"]; ok {
		t.Fatal("expired session should be removed")
	}
	if _, ok := srv.sessions["active1"]; !ok {
		t.Fatal("active session should remain")
	}
	if _, ok := srv.sessions["zero-time"]; !ok {
		t.Fatal("zero-time session should remain")
	}
}

func TestServer_CleanupRemovesOutboxEntries(t *testing.T) {
	srv := &Server{
		sessions: make(map[string]*Session),
		outbox:   NewOutbox(),
		stopCh:   make(chan struct{}),
	}

	expired := time.Now().Add(-time.Duration(engineIdleTimeoutMs+1000) * time.Millisecond)
	srv.sessions["sid1"] = &Session{
		SID:      "sid1",
		LastSeen: expired,
	}

	// Use broadcast entries (no engineID) so dequeue with empty filter works
	srv.outbox.Enqueue("/ns", "pkt1", "s1", "", "")
	srv.outbox.Enqueue("/ns", "pkt2", "", "", "")

	// Also add a targeted entry for the expired sid
	srv.outbox.Enqueue("/ns", "pkt-expired", "", "", "sid1")

	srv.cleanupExpiredSessions()

	// pkt-expired should be removed, pkt1 and pkt2 should remain
	got := o_dequeueAll(srv.outbox, "/ns")
	if len(got) != 2 {
		t.Fatalf("expected 2 remaining packets, got %d: %v", len(got), got)
	}
}

func TestServer_Stop(t *testing.T) {
	srv := &Server{
		sessions: make(map[string]*Session),
		outbox:   NewOutbox(),
		stopCh:   make(chan struct{}),
	}

	go srv.sessionCleanupLoop()

	srv.Stop()

	select {
	case <-srv.stopCh:
	default:
		t.Fatal("stopCh should be closed after Stop()")
	}

	// Double stop should not panic
	srv.Stop()
}

func TestServer_IsExpired(t *testing.T) {
	srv := &Server{}

	if !srv.isExpired(nil) {
		t.Fatal("nil session should be expired")
	}

	zeroSess := &Session{}
	if srv.isExpired(zeroSess) {
		t.Fatal("zero LastSeen should not be expired")
	}

	recentSess := &Session{LastSeen: time.Now().Add(-10 * time.Second)}
	if srv.isExpired(recentSess) {
		t.Fatal("recent session should not be expired")
	}

	oldSess := &Session{LastSeen: time.Now().Add(-time.Duration(engineIdleTimeoutMs+1000) * time.Millisecond)}
	if !srv.isExpired(oldSess) {
		t.Fatal("old session should be expired")
	}
}

// o_dequeueAll drains all entries from the outbox regardless of filters.
func o_dequeueAll(o *Outbox, ns string) []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	entries := o.queues[ns]
	var result []string
	for _, e := range entries {
		result = append(result, e.packet)
	}
	o.queues[ns] = nil
	return result
}
