package sync

import (
	"sync"

	"hub_go/internal/sse"
)

type SyncEventListener func(event SyncEvent)

type EventPublisher struct {
	bus              *sse.Bus
	resolveNamespace func(event SyncEvent) string
	mu               sync.RWMutex
	listeners        map[int]SyncEventListener
	nextID           int
}

func NewEventPublisher(bus *sse.Bus, resolveNamespace func(event SyncEvent) string) *EventPublisher {
	return &EventPublisher{
		bus:              bus,
		resolveNamespace: resolveNamespace,
		listeners:        map[int]SyncEventListener{},
	}
}

func (p *EventPublisher) Subscribe(listener SyncEventListener) func() {
	if listener == nil {
		return func() {}
	}
	p.mu.Lock()
	id := p.nextID
	p.nextID++
	p.listeners[id] = listener
	p.mu.Unlock()

	return func() {
		p.mu.Lock()
		delete(p.listeners, id)
		p.mu.Unlock()
	}
}

func (p *EventPublisher) Emit(event SyncEvent) {
	if p == nil {
		return
	}
	if p.resolveNamespace != nil && event.Namespace == "" {
		event.Namespace = p.resolveNamespace(event)
	}

	p.mu.RLock()
	for _, listener := range p.listeners {
		listener(event)
	}
	p.mu.RUnlock()

	if p.bus != nil {
		p.bus.Publish(toSSEEvent(event))
	}
}

func toSSEEvent(event SyncEvent) sse.Event {
	data := map[string]any{}
	if event.Namespace != "" {
		data["namespace"] = event.Namespace
	}
	if event.SessionID != "" {
		data["sessionId"] = event.SessionID
	}
	if event.MachineID != "" {
		data["machineId"] = event.MachineID
	}
	if event.Message != nil {
		data["message"] = event.Message
	}
	if event.Data != nil {
		data["data"] = event.Data
	}
	return sse.Event{Type: event.Type, Data: data}
}
