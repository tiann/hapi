package notifications

import (
	"sync"
	"time"

	syncengine "hub_go/internal/sync"
)

type SyncEngine interface {
	Subscribe(listener syncengine.SyncEventListener) func()
	GetSession(sessionID string) *syncengine.Session
}

type NotificationHub struct {
	engine                  SyncEngine
	channels                []NotificationChannel
	readyCooldownMs         int64
	permissionDebounceMs    int64
	lastKnownRequests       map[string]map[string]struct{}
	notificationDebounce    map[string]*time.Timer
	lastReadyNotificationAt map[string]int64
	unsubscribe             func()
	mu                      sync.Mutex
}

func NewNotificationHub(engine SyncEngine, channels []NotificationChannel, options *NotificationHubOptions) *NotificationHub {
	hub := &NotificationHub{
		engine:                  engine,
		channels:                channels,
		readyCooldownMs:         5000,
		permissionDebounceMs:    500,
		lastKnownRequests:       map[string]map[string]struct{}{},
		notificationDebounce:    map[string]*time.Timer{},
		lastReadyNotificationAt: map[string]int64{},
	}
	if options != nil {
		if options.ReadyCooldownMs > 0 {
			hub.readyCooldownMs = options.ReadyCooldownMs
		}
		if options.PermissionDebounceMs > 0 {
			hub.permissionDebounceMs = options.PermissionDebounceMs
		}
	}
	if engine != nil {
		hub.unsubscribe = engine.Subscribe(func(event syncengine.SyncEvent) {
			hub.handleSyncEvent(event)
		})
	}
	return hub
}

func (h *NotificationHub) Stop() {
	h.mu.Lock()
	if h.unsubscribe != nil {
		h.unsubscribe()
		h.unsubscribe = nil
	}
	for _, timer := range h.notificationDebounce {
		timer.Stop()
	}
	h.notificationDebounce = map[string]*time.Timer{}
	h.lastKnownRequests = map[string]map[string]struct{}{}
	h.lastReadyNotificationAt = map[string]int64{}
	h.mu.Unlock()
}

func (h *NotificationHub) handleSyncEvent(event syncengine.SyncEvent) {
	if event.Type == "session-updated" || event.Type == "session-added" {
		if event.SessionID == "" {
			return
		}
		session := h.getNotifiableSession(event.SessionID)
		if session == nil || !session.Active {
			h.clearSessionState(event.SessionID)
			return
		}
		h.checkForPermissionNotification(session)
		return
	}

	if event.Type == "session-removed" && event.SessionID != "" {
		h.clearSessionState(event.SessionID)
		return
	}

	if event.Type == "message-received" && event.SessionID != "" {
		eventType := extractMessageEventType(event)
		if eventType == "ready" {
			_ = h.sendReadyNotification(event.SessionID)
		}
	}
}

func (h *NotificationHub) clearSessionState(sessionID string) {
	h.mu.Lock()
	if timer := h.notificationDebounce[sessionID]; timer != nil {
		timer.Stop()
		delete(h.notificationDebounce, sessionID)
	}
	delete(h.lastKnownRequests, sessionID)
	delete(h.lastReadyNotificationAt, sessionID)
	h.mu.Unlock()
}

func (h *NotificationHub) getNotifiableSession(sessionID string) *syncengine.Session {
	if h.engine == nil {
		return nil
	}
	session := h.engine.GetSession(sessionID)
	if session == nil || !session.Active {
		return nil
	}
	return session
}

func (h *NotificationHub) checkForPermissionNotification(session *syncengine.Session) {
	requests := extractRequestIDs(session.AgentState)
	if requests == nil {
		return
	}

	h.mu.Lock()
	oldRequests := h.lastKnownRequests[session.ID]
	hasNew := false
	for id := range requests {
		if oldRequests == nil {
			hasNew = true
			break
		}
		if _, ok := oldRequests[id]; !ok {
			hasNew = true
			break
		}
	}
	h.lastKnownRequests[session.ID] = requests
	if !hasNew {
		h.mu.Unlock()
		return
	}

	if timer := h.notificationDebounce[session.ID]; timer != nil {
		timer.Stop()
	}
	h.notificationDebounce[session.ID] = time.AfterFunc(time.Duration(h.permissionDebounceMs)*time.Millisecond, func() {
		_ = h.sendPermissionNotification(session.ID)
	})
	h.mu.Unlock()
}

func (h *NotificationHub) sendPermissionNotification(sessionID string) error {
	session := h.getNotifiableSession(sessionID)
	if session == nil {
		return nil
	}
	for _, channel := range h.channels {
		_ = channel.SendPermissionRequest(session)
	}
	return nil
}

func (h *NotificationHub) sendReadyNotification(sessionID string) error {
	session := h.getNotifiableSession(sessionID)
	if session == nil {
		return nil
	}
	h.mu.Lock()
	last := h.lastReadyNotificationAt[sessionID]
	now := time.Now().UnixMilli()
	if now-last < h.readyCooldownMs {
		h.mu.Unlock()
		return nil
	}
	h.lastReadyNotificationAt[sessionID] = now
	h.mu.Unlock()

	for _, channel := range h.channels {
		_ = channel.SendReady(session)
	}
	return nil
}

func extractRequestIDs(agentState any) map[string]struct{} {
	state, ok := agentState.(map[string]any)
	if !ok {
		return nil
	}
	raw, ok := state["requests"].(map[string]any)
	if !ok {
		return nil
	}
	ids := map[string]struct{}{}
	for id := range raw {
		ids[id] = struct{}{}
	}
	return ids
}
