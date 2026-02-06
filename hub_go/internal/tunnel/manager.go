package tunnel

import "sync"

type Manager struct {
	mu      sync.Mutex
	enabled bool
}

func NewManager() *Manager {
	return &Manager{}
}

func (m *Manager) Start() {
	if m == nil {
		return
	}
	m.mu.Lock()
	m.enabled = true
	m.mu.Unlock()
}

func (m *Manager) Stop() {
	if m == nil {
		return
	}
	m.mu.Lock()
	m.enabled = false
	m.mu.Unlock()
}

func (m *Manager) Enabled() bool {
	if m == nil {
		return false
	}
	m.mu.Lock()
	enabled := m.enabled
	m.mu.Unlock()
	return enabled
}
