package socketio

import "sync"

const maxOutboxPerNamespace = 1000

type Outbox struct {
	mu     sync.Mutex
	queues map[string][]outboxEntry
}

type outboxEntry struct {
	packet    string
	sessionID string
	machineID string
	engineID  string
}

func NewOutbox() *Outbox {
	return &Outbox{queues: make(map[string][]outboxEntry)}
}

func (o *Outbox) Enqueue(namespace string, packet string, sessionID string, machineID string, engineID string) {
	if packet == "" {
		return
	}
	o.mu.Lock()
	q := o.queues[namespace]
	q = append(q, outboxEntry{
		packet:    packet,
		sessionID: sessionID,
		machineID: machineID,
		engineID:  engineID,
	})
	if len(q) > maxOutboxPerNamespace {
		q = q[len(q)-maxOutboxPerNamespace:]
	}
	o.queues[namespace] = q
	o.mu.Unlock()
}

func (o *Outbox) Dequeue(namespace string, sessionID string, machineID string, engineID string) []string {
	o.mu.Lock()
	defer o.mu.Unlock()

	entries := o.queues[namespace]
	if len(entries) == 0 {
		return nil
	}
	var matched []string
	var remaining []outboxEntry
	for _, entry := range entries {
		if entry.engineID != "" && entry.engineID != engineID {
			remaining = append(remaining, entry)
			continue
		}
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

func (o *Outbox) RemoveByEngine(engineID string) {
	if engineID == "" {
		return
	}
	o.mu.Lock()
	for ns, entries := range o.queues {
		var remaining []outboxEntry
		for _, entry := range entries {
			if entry.engineID != engineID {
				remaining = append(remaining, entry)
			}
		}
		if len(remaining) == 0 {
			delete(o.queues, ns)
		} else {
			o.queues[ns] = remaining
		}
	}
	o.mu.Unlock()
}
