package sse

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"sync"
)

type Event struct {
	Type string
	Data map[string]any
}

type Bus struct {
	mu   sync.RWMutex
	subs map[chan Event]struct{}
}

func NewBus() *Bus {
	return &Bus{subs: make(map[chan Event]struct{})}
}

func (b *Bus) Subscribe(buffer int) chan Event {
	ch := make(chan Event, buffer)
	b.mu.Lock()
	b.subs[ch] = struct{}{}
	b.mu.Unlock()
	return ch
}

func (b *Bus) Unsubscribe(ch chan Event) {
	b.mu.Lock()
	if _, ok := b.subs[ch]; ok {
		delete(b.subs, ch)
		close(ch)
	}
	b.mu.Unlock()
}

func (b *Bus) Publish(event Event) {
	b.mu.RLock()
	for ch := range b.subs {
		select {
		case ch <- event:
		default:
		}
	}
	b.mu.RUnlock()
}

func (b *Bus) PublishCount(event Event) int {
	delivered := 0
	dropped := 0
	b.mu.RLock()
	for ch := range b.subs {
		select {
		case ch <- event:
			delivered++
		default:
			dropped++
		}
	}
	b.mu.RUnlock()
	if dropped > 0 {
		log.Printf("[SSE] Event %s: delivered=%d dropped=%d", event.Type, delivered, dropped)
	}
	return delivered
}

func NewSubscriptionID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "00000000000000000000000000000000"
	}
	return hex.EncodeToString(buf)
}
