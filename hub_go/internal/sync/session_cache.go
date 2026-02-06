package sync

import (
	"sync"
	"time"

	"hub_go/internal/store"
)

type SessionCache struct {
	store           *store.Store
	publisher       *EventPublisher
	mu              sync.RWMutex
	sessions        map[string]*Session
	lastBroadcastAt map[string]int64
}

func NewSessionCache(store *store.Store, publisher *EventPublisher) *SessionCache {
	return &SessionCache{
		store:           store,
		publisher:       publisher,
		sessions:        map[string]*Session{},
		lastBroadcastAt: map[string]int64{},
	}
}

func (c *SessionCache) ReloadAll(namespace string) {
	if c == nil || c.store == nil {
		return
	}
	sessions := c.store.ListSessions(namespace)
	c.mu.Lock()
	for i := range sessions {
		session := sessions[i]
		c.sessions[session.ID] = &session
	}
	c.mu.Unlock()
}

func (c *SessionCache) GetSession(id string) *Session {
	c.mu.RLock()
	session := c.sessions[id]
	c.mu.RUnlock()
	if session != nil {
		return session
	}
	return c.RefreshSession(id, "default")
}

func (c *SessionCache) GetSessionsByNamespace(namespace string) []Session {
	if c == nil || c.store == nil {
		return nil
	}
	sessions := c.store.ListSessions(namespace)
	c.mu.Lock()
	for i := range sessions {
		session := sessions[i]
		c.sessions[session.ID] = &session
	}
	c.mu.Unlock()
	return sessions
}

func (c *SessionCache) RefreshSession(id string, namespace string) *Session {
	if c == nil || c.store == nil {
		return nil
	}
	session, _ := c.store.GetSession(namespace, id)
	if session == nil {
		return nil
	}
	c.mu.Lock()
	c.sessions[id] = session
	c.mu.Unlock()
	return session
}

func (c *SessionCache) HandleSessionAlive(payload SessionAlivePayload) {
	if c == nil || c.store == nil {
		return
	}
	aliveAt := clampAliveTime(payload.Time)
	if aliveAt == 0 {
		aliveAt = time.Now().UnixMilli()
	}

	created := false
	session := c.GetSession(payload.SessionID)
	if session == nil {
		session, _ = c.store.CreateSessionWithID(payload.Namespace, payload.SessionID, nil, nil)
		created = session != nil
		if session != nil {
			c.mu.Lock()
			c.sessions[session.ID] = session
			c.mu.Unlock()
		}
	}
	if session == nil {
		return
	}

	wasActive := session.Active
	wasThinking := session.Thinking
	previousPermission := session.PermissionMode
	previousModel := session.ModelMode

	session.Active = true
	session.ActiveAt = maxInt64(session.ActiveAt, aliveAt)
	session.Thinking = payload.Thinking
	session.ThinkingAt = aliveAt
	if payload.PermissionMode != "" {
		session.PermissionMode = payload.PermissionMode
	}
	if payload.ModelMode != "" {
		session.ModelMode = payload.ModelMode
	}
	session.UpdatedAt = time.Now().UnixMilli()
	_ = c.store.UpdateSession(payload.Namespace, session)

	if created && c.publisher != nil {
		c.publisher.Emit(SyncEvent{
			Type:      "session-added",
			Namespace: payload.Namespace,
			SessionID: session.ID,
			Data:      SessionEventData(session),
		})
	}

	now := time.Now().UnixMilli()
	c.mu.Lock()
	last := c.lastBroadcastAt[session.ID]
	c.lastBroadcastAt[session.ID] = now
	c.mu.Unlock()

	modeChanged := previousPermission != session.PermissionMode || previousModel != session.ModelMode
	shouldBroadcast := (!wasActive && session.Active) || (wasThinking != session.Thinking) || modeChanged || (now-last > 10_000)

	if shouldBroadcast && c.publisher != nil {
		c.publisher.Emit(SyncEvent{
			Type:      "session-updated",
			Namespace: payload.Namespace,
			SessionID: session.ID,
			Data: map[string]any{
				"activeAt":       session.ActiveAt,
				"thinking":       session.Thinking,
				"permissionMode": nullIfEmpty(session.PermissionMode),
				"modelMode":      nullIfEmpty(session.ModelMode),
			},
		})
	}
}

func (c *SessionCache) HandleSessionEnd(payload SessionEndPayload) {
	if c == nil || c.store == nil {
		return
	}
	endedAt := clampAliveTime(payload.Time)
	if endedAt == 0 {
		endedAt = time.Now().UnixMilli()
	}
	session := c.GetSession(payload.SessionID)
	if session == nil {
		return
	}
	if !session.Active && !session.Thinking {
		return
	}
	session.Active = false
	session.Thinking = false
	session.ThinkingAt = endedAt
	session.UpdatedAt = time.Now().UnixMilli()
	_ = c.store.UpdateSession(payload.Namespace, session)

	if c.publisher != nil {
		c.publisher.Emit(SyncEvent{
			Type:      "session-updated",
			Namespace: payload.Namespace,
			SessionID: session.ID,
			Data: map[string]any{
				"active":   false,
				"thinking": false,
			},
		})
	}
}

func (c *SessionCache) ApplySessionConfig(sessionID string, namespace string, permissionMode string, modelMode string) {
	session := c.GetSession(sessionID)
	if session == nil {
		return
	}
	if permissionMode != "" {
		session.PermissionMode = permissionMode
	}
	if modelMode != "" {
		session.ModelMode = modelMode
	}
	session.UpdatedAt = time.Now().UnixMilli()
	_ = c.store.UpdateSession(namespace, session)

	if c.publisher != nil {
		c.publisher.Emit(SyncEvent{
			Type:      "session-updated",
			Namespace: namespace,
			SessionID: session.ID,
			Data: map[string]any{
				"permissionMode": nullIfEmpty(session.PermissionMode),
				"modelMode":      nullIfEmpty(session.ModelMode),
			},
		})
	}
}

func clampAliveTime(value int64) int64 {
	if value <= 0 {
		return 0
	}
	now := time.Now().UnixMilli()
	if value > now+60_000 || value < now-60_000 {
		return 0
	}
	return value
}

func maxInt64(a int64, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func nullIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}
