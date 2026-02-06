package sync

import (
	"hub_go/internal/sse"
	"hub_go/internal/store"
)

type Engine struct {
	store          *store.Store
	publisher      *EventPublisher
	sessionCache   *SessionCache
	machineCache   *MachineCache
	messageService *MessageService
	rpcGateway     *RpcGateway
}

type EngineDeps struct {
	Store             *store.Store
	SSEBus            *sse.Bus
	RpcSender         RpcSender
	NamespaceResolver func(event SyncEvent) string
}

func NewEngine(deps EngineDeps) *Engine {
	publisher := NewEventPublisher(deps.SSEBus, deps.NamespaceResolver)
	sessionCache := NewSessionCache(deps.Store, publisher)
	machineCache := NewMachineCache(deps.Store, publisher)
	messageService := NewMessageService(deps.Store)
	rpcGateway := NewRpcGateway(deps.RpcSender)

	return &Engine{
		store:          deps.Store,
		publisher:      publisher,
		sessionCache:   sessionCache,
		machineCache:   machineCache,
		messageService: messageService,
		rpcGateway:     rpcGateway,
	}
}

func (e *Engine) Subscribe(listener SyncEventListener) func() {
	if e == nil || e.publisher == nil {
		return func() {}
	}
	return e.publisher.Subscribe(listener)
}

func (e *Engine) GetSession(sessionID string) *store.Session {
	if e == nil || e.sessionCache == nil {
		return nil
	}
	return e.sessionCache.GetSession(sessionID)
}

func (e *Engine) GetSessionByNamespace(sessionID string, namespace string) *store.Session {
	if e == nil || e.store == nil {
		return nil
	}
	session, _ := e.store.GetSession(namespace, sessionID)
	if session != nil {
		if e.sessionCache != nil {
			e.sessionCache.RefreshSession(sessionID, namespace)
		}
	}
	return session
}

func (e *Engine) GetSessionsByNamespace(namespace string) []store.Session {
	if e == nil || e.sessionCache == nil {
		return nil
	}
	return e.sessionCache.GetSessionsByNamespace(namespace)
}

func (e *Engine) GetMachine(machineID string, namespace string) *store.Machine {
	if e == nil || e.machineCache == nil {
		return nil
	}
	return e.machineCache.GetMachine(machineID, namespace)
}

func (e *Engine) GetMachinesByNamespace(namespace string) []store.Machine {
	if e == nil || e.machineCache == nil {
		return nil
	}
	return e.machineCache.GetMachinesByNamespace(namespace)
}

func (e *Engine) GetMessagesPage(sessionID string, limit int, beforeSeq int64) MessagesPage {
	if e == nil || e.messageService == nil {
		return MessagesPage{}
	}
	return e.messageService.GetMessagesPage(sessionID, limit, beforeSeq)
}

func (e *Engine) GetMessagesAfter(sessionID string, limit int, afterSeq int64) []store.Message {
	if e == nil || e.messageService == nil {
		return nil
	}
	return e.messageService.GetMessagesAfter(sessionID, limit, afterSeq)
}

func (e *Engine) HandleRealtimeEvent(event SyncEvent) {
	if e == nil {
		return
	}
	if event.Type == "session-updated" && event.SessionID != "" {
		e.sessionCache.RefreshSession(event.SessionID, event.Namespace)
	}
	if event.Type == "machine-updated" && event.MachineID != "" {
		e.machineCache.GetMachine(event.MachineID, event.Namespace)
	}
	if event.Type == "message-received" && event.SessionID != "" {
		if e.GetSession(event.SessionID) == nil {
			e.sessionCache.RefreshSession(event.SessionID, event.Namespace)
		}
	}
	if e.publisher != nil {
		e.publisher.Emit(event)
	}
}

func (e *Engine) HandleSessionAlive(payload SessionAlivePayload) {
	if e == nil || e.sessionCache == nil {
		return
	}
	e.sessionCache.HandleSessionAlive(payload)
}

func (e *Engine) HandleSessionEnd(payload SessionEndPayload) {
	if e == nil || e.sessionCache == nil {
		return
	}
	e.sessionCache.HandleSessionEnd(payload)
}

func (e *Engine) HandleMachineAlive(payload MachineAlivePayload) {
	if e == nil || e.machineCache == nil {
		return
	}
	e.machineCache.HandleMachineAlive(payload)
}

func (e *Engine) RpcGateway() *RpcGateway {
	if e == nil {
		return nil
	}
	return e.rpcGateway
}
