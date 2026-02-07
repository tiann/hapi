package sse

import "sync"

type VisibilityTracker struct {
	mu   sync.RWMutex
	byID map[string]*visibilityEntry
}

type visibilityEntry struct {
	Namespace  string
	Visibility string
}

func NewVisibilityTracker() *VisibilityTracker {
	return &VisibilityTracker{byID: make(map[string]*visibilityEntry)}
}

func (t *VisibilityTracker) Register(id string, namespace string) {
	if id == "" {
		return
	}
	t.mu.Lock()
	t.byID[id] = &visibilityEntry{Namespace: namespace, Visibility: "visible"}
	t.mu.Unlock()
}

func (t *VisibilityTracker) Unregister(id string) {
	if id == "" {
		return
	}
	t.mu.Lock()
	delete(t.byID, id)
	t.mu.Unlock()
}

func (t *VisibilityTracker) SetVisibility(id string, namespace string, visibility string) bool {
	if id == "" || (visibility != "visible" && visibility != "hidden") {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	entry, ok := t.byID[id]
	if !ok {
		return false
	}
	if entry.Namespace != namespace {
		return false
	}
	entry.Visibility = visibility
	return true
}

// HasVisibleConnection checks if there's at least one visible SSE connection for a namespace
func (t *VisibilityTracker) HasVisibleConnection(namespace string) bool {
	if t == nil {
		return false
	}
	t.mu.RLock()
	defer t.mu.RUnlock()
	for _, entry := range t.byID {
		if entry.Namespace == namespace && entry.Visibility == "visible" {
			return true
		}
	}
	return false
}
