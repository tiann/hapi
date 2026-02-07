package sse

import (
	"testing"
	"time"
)

func TestBus_SubscribeAndPublish(t *testing.T) {
	bus := NewBus()
	ch := bus.Subscribe(10)
	defer bus.Unsubscribe(ch)

	bus.Publish(Event{Type: "test", Data: map[string]any{"key": "value"}})

	select {
	case event := <-ch:
		if event.Type != "test" {
			t.Fatalf("Type = %q, want test", event.Type)
		}
		if event.Data["key"] != "value" {
			t.Fatalf("Data = %v", event.Data)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("timeout waiting for event")
	}
}

func TestBus_MultipleSubscribers(t *testing.T) {
	bus := NewBus()
	ch1 := bus.Subscribe(10)
	ch2 := bus.Subscribe(10)
	defer bus.Unsubscribe(ch1)
	defer bus.Unsubscribe(ch2)

	bus.Publish(Event{Type: "broadcast"})

	for i, ch := range []chan Event{ch1, ch2} {
		select {
		case event := <-ch:
			if event.Type != "broadcast" {
				t.Fatalf("subscriber %d: Type = %q", i, event.Type)
			}
		case <-time.After(100 * time.Millisecond):
			t.Fatalf("subscriber %d: timeout", i)
		}
	}
}

func TestBus_Unsubscribe(t *testing.T) {
	bus := NewBus()
	ch := bus.Subscribe(10)
	bus.Unsubscribe(ch)

	// channel should be closed
	_, ok := <-ch
	if ok {
		t.Fatal("channel should be closed after unsubscribe")
	}

	// publishing after unsubscribe should not panic
	bus.Publish(Event{Type: "after-unsub"})
}

func TestBus_PublishCount(t *testing.T) {
	bus := NewBus()
	ch1 := bus.Subscribe(10)
	ch2 := bus.Subscribe(10)
	defer bus.Unsubscribe(ch1)
	defer bus.Unsubscribe(ch2)

	count := bus.PublishCount(Event{Type: "counted"})
	if count != 2 {
		t.Fatalf("PublishCount = %d, want 2", count)
	}
}

func TestBus_PublishCount_DroppedEvents(t *testing.T) {
	bus := NewBus()
	// buffer=1, fill it up
	ch := bus.Subscribe(1)
	defer bus.Unsubscribe(ch)

	bus.Publish(Event{Type: "fill"})
	// second publish should drop (buffer full)
	count := bus.PublishCount(Event{Type: "overflow"})
	if count != 0 {
		t.Fatalf("PublishCount with full buffer = %d, want 0", count)
	}
}

func TestBus_NoSubscribers(t *testing.T) {
	bus := NewBus()
	// should not panic
	bus.Publish(Event{Type: "no-one-listening"})
	count := bus.PublishCount(Event{Type: "no-one-counting"})
	if count != 0 {
		t.Fatalf("PublishCount with no subs = %d, want 0", count)
	}
}

func TestNewSubscriptionID(t *testing.T) {
	id1 := NewSubscriptionID()
	id2 := NewSubscriptionID()
	if len(id1) != 32 {
		t.Fatalf("ID length = %d, want 32", len(id1))
	}
	if id1 == id2 {
		t.Fatal("two IDs should not be identical")
	}
}
