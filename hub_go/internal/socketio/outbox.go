package socketio

import "sync"

type Outbox struct {
	mu     sync.Mutex
	queues map[string][]outboxEntry
}

type outboxEntry struct {
	packet    string
	sessionID string
	machineID string
}

func NewOutbox() *Outbox {
	return &Outbox{queues: make(map[string][]outboxEntry)}
}

func (o *Outbox) Enqueue(namespace string, packet string, sessionID string, machineID string) {
	if packet == "" {
		return
	}
	o.mu.Lock()
	o.queues[namespace] = append(o.queues[namespace], outboxEntry{
		packet:    packet,
		sessionID: sessionID,
		machineID: machineID,
	})
	o.mu.Unlock()
}

func (o *Outbox) Dequeue(namespace string, sessionID string, machineID string) []string {
	o.mu.Lock()
	defer o.mu.Unlock()

	entries := o.queues[namespace]
	if len(entries) == 0 {
		return nil
	}
	var matched []string
	var remaining []outboxEntry
	for _, entry := range entries {
		if entry.sessionID != "" && entry.sessionID != sessionID {
			remaining = append(remaining, entry)
			continue
		}
		if entry.machineID != "" && entry.machineID != machineID {
			remaining = append(remaining, entry)
			continue
		}
		matched = append(matched, entry.packet)
	}
	o.queues[namespace] = remaining
	return matched
}
