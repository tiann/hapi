package socketio

import "testing"

func TestOutbox_EnqueueDequeue(t *testing.T) {
	o := NewOutbox()
	o.Enqueue("/test", "pkt1", "", "", "")
	o.Enqueue("/test", "pkt2", "", "", "")

	got := o.Dequeue("/test", "", "", "")
	if len(got) != 2 {
		t.Fatalf("expected 2 broadcast packets, got %d", len(got))
	}

	// Queue should be empty now
	got2 := o.Dequeue("/test", "", "", "")
	if len(got2) != 0 {
		t.Fatalf("expected 0 after drain, got %d", len(got2))
	}
}

func TestOutbox_SessionFilter(t *testing.T) {
	o := NewOutbox()
	o.Enqueue("/ns", "a", "s1", "", "")
	o.Enqueue("/ns", "b", "s2", "", "")
	o.Enqueue("/ns", "c", "", "", "")

	got := o.Dequeue("/ns", "s1", "", "")
	// "a" matches (sessionID=s1), "c" matches (no filter on entry)
	if len(got) != 2 {
		t.Fatalf("expected 2, got %d: %v", len(got), got)
	}

	// Remaining should be "b" (sessionID=s2)
	remaining := o.Dequeue("/ns", "s2", "", "")
	if len(remaining) != 1 || remaining[0] != "b" {
		t.Fatalf("expected [b], got %v", remaining)
	}
}

func TestOutbox_EngineFilter(t *testing.T) {
	o := NewOutbox()
	o.Enqueue("/ns", "a", "", "", "e1")
	o.Enqueue("/ns", "b", "", "", "e2")

	got := o.Dequeue("/ns", "", "", "e1")
	if len(got) != 1 || got[0] != "a" {
		t.Fatalf("expected [a], got %v", got)
	}
}

func TestOutbox_EmptyPacket(t *testing.T) {
	o := NewOutbox()
	o.Enqueue("/ns", "", "", "", "")
	got := o.Dequeue("/ns", "", "", "")
	if len(got) != 0 {
		t.Fatalf("empty packet should not be enqueued, got %d", len(got))
	}
}

func TestOutbox_CapacityLimit(t *testing.T) {
	o := NewOutbox()
	for i := 0; i < maxOutboxPerNamespace+100; i++ {
		o.Enqueue("/ns", "pkt", "", "", "")
	}
	got := o.Dequeue("/ns", "", "", "")
	if len(got) != maxOutboxPerNamespace {
		t.Fatalf("expected %d (capped), got %d", maxOutboxPerNamespace, len(got))
	}
}

func TestOutbox_RemoveByEngine(t *testing.T) {
	o := NewOutbox()
	o.Enqueue("/ns1", "a", "", "", "e1")
	o.Enqueue("/ns1", "b", "", "", "e2")
	o.Enqueue("/ns2", "c", "", "", "e1")
	o.Enqueue("/ns2", "d", "", "", "")

	o.RemoveByEngine("e1")

	// ns1: only "b" (e2) remains, need to dequeue with e2 filter
	got1 := o.Dequeue("/ns1", "", "", "e2")
	if len(got1) != 1 || got1[0] != "b" {
		t.Fatalf("ns1: expected [b], got %v", got1)
	}

	// ns2: "d" (broadcast, no engineID) remains
	got2 := o.Dequeue("/ns2", "", "", "")
	if len(got2) != 1 || got2[0] != "d" {
		t.Fatalf("ns2: expected [d], got %v", got2)
	}
}

func TestOutbox_RemoveByEngine_Empty(t *testing.T) {
	o := NewOutbox()
	o.RemoveByEngine("") // should not panic
	o.RemoveByEngine("nonexistent")
}

func TestOutbox_DifferentNamespaces(t *testing.T) {
	o := NewOutbox()
	o.Enqueue("/a", "pkt-a", "", "", "")
	o.Enqueue("/b", "pkt-b", "", "", "")

	gotA := o.Dequeue("/a", "", "", "")
	if len(gotA) != 1 || gotA[0] != "pkt-a" {
		t.Fatalf("expected [pkt-a], got %v", gotA)
	}

	gotB := o.Dequeue("/b", "", "", "")
	if len(gotB) != 1 || gotB[0] != "pkt-b" {
		t.Fatalf("expected [pkt-b], got %v", gotB)
	}
}
