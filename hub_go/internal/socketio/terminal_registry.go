package socketio

import (
	"sync"
	"time"
)

type terminalEntry struct {
	TerminalID string
	SessionID  string
	SocketID   string
	CliConn    *wsConn
	LastSeen   time.Time
}

type TerminalRegistry struct {
	mu                 sync.RWMutex
	byTerminalID       map[string]*terminalEntry
	bySocketID         map[string]map[string]struct{}
	bySessionID        map[string]map[string]struct{}
	byCliConn          map[*wsConn]map[string]struct{}
	maxPerSocket       int
	maxPerSession      int
	idleTimeout        time.Duration
	onIdle             func(entry terminalEntry)
	stopIdleLoop       chan struct{}
	idleLoopStarted    bool
}

func NewTerminalRegistry(maxPerSocket int, maxPerSession int, idleTimeout time.Duration, onIdle func(entry terminalEntry)) *TerminalRegistry {
	registry := &TerminalRegistry{
		byTerminalID:  make(map[string]*terminalEntry),
		bySocketID:    make(map[string]map[string]struct{}),
		bySessionID:   make(map[string]map[string]struct{}),
		byCliConn:     make(map[*wsConn]map[string]struct{}),
		maxPerSocket:  maxPerSocket,
		maxPerSession: maxPerSession,
		idleTimeout:   idleTimeout,
		onIdle:        onIdle,
		stopIdleLoop:  make(chan struct{}),
	}
	return registry
}

func (r *TerminalRegistry) StartIdleLoop(interval time.Duration) {
	if r == nil {
		return
	}
	r.mu.Lock()
	if r.idleLoopStarted {
		r.mu.Unlock()
		return
	}
	r.idleLoopStarted = true
	r.mu.Unlock()

	if interval <= 0 {
		interval = 5 * time.Second
	}

	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-r.stopIdleLoop:
				return
			case <-ticker.C:
				r.expireIdle()
			}
		}
	}()
}

func (r *TerminalRegistry) StopIdleLoop() {
	if r == nil {
		return
	}
	r.mu.Lock()
	if !r.idleLoopStarted {
		r.mu.Unlock()
		return
	}
	r.idleLoopStarted = false
	close(r.stopIdleLoop)
	r.mu.Unlock()
}

func (r *TerminalRegistry) CountForSocket(socketID string) int {
	if r == nil || socketID == "" {
		return 0
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.bySocketID[socketID])
}

func (r *TerminalRegistry) CountForSession(sessionID string) int {
	if r == nil || sessionID == "" {
		return 0
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.bySessionID[sessionID])
}

func (r *TerminalRegistry) Get(terminalID string) *terminalEntry {
	if r == nil || terminalID == "" {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	entry := r.byTerminalID[terminalID]
	if entry == nil {
		return nil
	}
	copy := *entry
	return &copy
}

func (r *TerminalRegistry) Register(terminalID string, sessionID string, socketID string, cliConn *wsConn) (*terminalEntry, string) {
	if r == nil {
		return nil, "internal"
	}
	if terminalID == "" || sessionID == "" || socketID == "" || cliConn == nil {
		return nil, "invalid"
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.byTerminalID[terminalID]; exists {
		return nil, "in_use"
	}

	if r.maxPerSocket > 0 {
		if len(r.bySocketID[socketID]) >= r.maxPerSocket {
			return nil, "too_many_socket"
		}
	}

	if r.maxPerSession > 0 {
		if len(r.bySessionID[sessionID]) >= r.maxPerSession {
			return nil, "too_many_session"
		}
	}

	entry := &terminalEntry{
		TerminalID: terminalID,
		SessionID:  sessionID,
		SocketID:   socketID,
		CliConn:    cliConn,
		LastSeen:   time.Now(),
	}
	r.byTerminalID[terminalID] = entry

	if _, ok := r.bySocketID[socketID]; !ok {
		r.bySocketID[socketID] = make(map[string]struct{})
	}
	r.bySocketID[socketID][terminalID] = struct{}{}

	if _, ok := r.bySessionID[sessionID]; !ok {
		r.bySessionID[sessionID] = make(map[string]struct{})
	}
	r.bySessionID[sessionID][terminalID] = struct{}{}

	if _, ok := r.byCliConn[cliConn]; !ok {
		r.byCliConn[cliConn] = make(map[string]struct{})
	}
	r.byCliConn[cliConn][terminalID] = struct{}{}

	copy := *entry
	return &copy, ""
}

func (r *TerminalRegistry) MarkActivity(terminalID string) {
	if r == nil || terminalID == "" {
		return
	}
	r.mu.Lock()
	if entry := r.byTerminalID[terminalID]; entry != nil {
		entry.LastSeen = time.Now()
	}
	r.mu.Unlock()
}

func (r *TerminalRegistry) Remove(terminalID string) *terminalEntry {
	if r == nil || terminalID == "" {
		return nil
	}
	r.mu.Lock()
	entry := r.byTerminalID[terminalID]
	if entry == nil {
		r.mu.Unlock()
		return nil
	}
	delete(r.byTerminalID, terminalID)

	if set := r.bySocketID[entry.SocketID]; set != nil {
		delete(set, terminalID)
		if len(set) == 0 {
			delete(r.bySocketID, entry.SocketID)
		}
	}

	if set := r.bySessionID[entry.SessionID]; set != nil {
		delete(set, terminalID)
		if len(set) == 0 {
			delete(r.bySessionID, entry.SessionID)
		}
	}

	if set := r.byCliConn[entry.CliConn]; set != nil {
		delete(set, terminalID)
		if len(set) == 0 {
			delete(r.byCliConn, entry.CliConn)
		}
	}

	copy := *entry
	r.mu.Unlock()
	return &copy
}

func (r *TerminalRegistry) RemoveBySocket(socketID string) []terminalEntry {
	if r == nil || socketID == "" {
		return nil
	}
	r.mu.Lock()
	ids := r.bySocketID[socketID]
	if len(ids) == 0 {
		r.mu.Unlock()
		return nil
	}
	var removed []terminalEntry
	for terminalID := range ids {
		entry := r.byTerminalID[terminalID]
		if entry == nil {
			continue
		}
		removed = append(removed, *entry)
		delete(r.byTerminalID, terminalID)

		if set := r.bySessionID[entry.SessionID]; set != nil {
			delete(set, terminalID)
			if len(set) == 0 {
				delete(r.bySessionID, entry.SessionID)
			}
		}
		if set := r.byCliConn[entry.CliConn]; set != nil {
			delete(set, terminalID)
			if len(set) == 0 {
				delete(r.byCliConn, entry.CliConn)
			}
		}
	}
	delete(r.bySocketID, socketID)
	r.mu.Unlock()
	return removed
}

func (r *TerminalRegistry) RemoveByCliConn(conn *wsConn) []terminalEntry {
	if r == nil || conn == nil {
		return nil
	}
	r.mu.Lock()
	ids := r.byCliConn[conn]
	if len(ids) == 0 {
		r.mu.Unlock()
		return nil
	}
	var removed []terminalEntry
	for terminalID := range ids {
		entry := r.byTerminalID[terminalID]
		if entry == nil {
			continue
		}
		removed = append(removed, *entry)
		delete(r.byTerminalID, terminalID)

		if set := r.bySocketID[entry.SocketID]; set != nil {
			delete(set, terminalID)
			if len(set) == 0 {
				delete(r.bySocketID, entry.SocketID)
			}
		}
		if set := r.bySessionID[entry.SessionID]; set != nil {
			delete(set, terminalID)
			if len(set) == 0 {
				delete(r.bySessionID, entry.SessionID)
			}
		}
	}
	delete(r.byCliConn, conn)
	r.mu.Unlock()
	return removed
}

func (r *TerminalRegistry) expireIdle() {
	if r == nil || r.idleTimeout <= 0 {
		return
	}

	now := time.Now()
	var expired []terminalEntry

	r.mu.Lock()
	for terminalID, entry := range r.byTerminalID {
		if entry == nil {
			continue
		}
		if now.Sub(entry.LastSeen) <= r.idleTimeout {
			continue
		}
		expired = append(expired, *entry)

		delete(r.byTerminalID, terminalID)
		if set := r.bySocketID[entry.SocketID]; set != nil {
			delete(set, terminalID)
			if len(set) == 0 {
				delete(r.bySocketID, entry.SocketID)
			}
		}
		if set := r.bySessionID[entry.SessionID]; set != nil {
			delete(set, terminalID)
			if len(set) == 0 {
				delete(r.bySessionID, entry.SessionID)
			}
		}
		if set := r.byCliConn[entry.CliConn]; set != nil {
			delete(set, terminalID)
			if len(set) == 0 {
				delete(r.byCliConn, entry.CliConn)
			}
		}
	}
	r.mu.Unlock()

	if len(expired) == 0 {
		return
	}

	if r.onIdle != nil {
		for _, entry := range expired {
			r.onIdle(entry)
		}
	}
}

