package socketio

import (
	"encoding/json"
	"fmt"
	"log"
	"time"

	"hub_go/internal/sse"
	"hub_go/internal/store"
	syncengine "hub_go/internal/sync"
)

type Dependencies struct {
	Store       *store.Store
	SSE         *sse.Bus
	Send        func(namespace string, event string, payload any)
	CliApiToken string
	JWTSecret   []byte
	Engine      *syncengine.Engine
}

func (s *Server) handleEvent(namespace string, event string, payload json.RawMessage) (any, bool) {
	if s.deps.Store == nil {
		return nil, false
	}

	if namespace == "" {
		namespace = "default"
	}

	switch namespace {
	case "/cli":
		return s.handleCliEvent("", nil, event, payload)
	case "/terminal":
		return s.handleTerminalEvent("", nil, event, payload)
	default:
		return nil, false
	}
}

func (s *Server) handleEventWS(conn *wsConn, namespace string, event string, payload json.RawMessage) (any, bool) {
	if namespace == "/cli" {
		if method, ok := parseRpcMethod(payload); ok {
			switch event {
			case "rpc-register":
				s.registerRpcMethod(method, conn)
				return nil, false
			case "rpc-unregister":
				s.unregisterRpcMethod(method, conn)
				return nil, false
			}
		}
	}
	engineID := ""
	if conn != nil {
		engineID = conn.engineID
	}
	return s.handleEventWithEngine(engineID, conn, namespace, event, payload)
}

func (s *Server) handleEventWithEngine(engineID string, conn *wsConn, namespace string, event string, payload json.RawMessage) (any, bool) {
	if s.deps.Store == nil {
		return nil, false
	}

	if namespace == "" {
		namespace = "/"
	}

	switch namespace {
	case "/cli":
		return s.handleCliEvent(engineID, conn, event, payload)
	case "/terminal":
		return s.handleTerminalEvent(engineID, conn, event, payload)
	default:
		return nil, false
	}
}

func (s *Server) handleCliEvent(engineID string, conn *wsConn, event string, payload json.RawMessage) (any, bool) {
	var data map[string]any
	if err := json.Unmarshal(payload, &data); err != nil {
		return nil, false
	}

	namespace := "default"
	if conn != nil && conn.hapiNS != "" {
		namespace = conn.hapiNS
	}

	sid, _ := data["sid"].(string)
	sessionID := sid
	if sessionID == "" {
		sessionID, _ = data["sessionId"].(string)
	}

	terminalID, _ := data["terminalId"].(string)

	switch event {
	case "message":
		if sessionID == "" {
			return nil, false
		}
		created := false
		if existing, _ := s.deps.Store.GetSession(namespace, sessionID); existing == nil {
			if _, err := s.deps.Store.CreateSessionWithID(namespace, sessionID, nil, nil); err != nil {
				log.Printf("[SocketIO] Failed to create session %s: %v", sessionID, err)
			} else {
				created = true
			}
		}
		content := parseMessageContent(data["message"])
		localID, _ := data["localId"].(string)
		msg := s.deps.Store.AddMessage(sessionID, content, localID)
		todos := syncengine.ExtractTodoWriteTodosFromMessageContent(content)
		if todos != nil {
			_ = s.deps.Store.SetSessionTodos(namespace, sessionID, todos, msg.CreatedAt)
		}
		if s.deps.Engine != nil {
			if created {
				if session, _ := s.deps.Store.GetSession(namespace, sessionID); session != nil {
					s.deps.Engine.HandleRealtimeEvent(syncengine.SyncEvent{
						Type:      "session-added",
						Namespace: namespace,
						SessionID: sessionID,
						Data:      syncengine.SessionEventData(session),
					})
				}
			}
			s.deps.Engine.HandleRealtimeEvent(syncengine.SyncEvent{
				Type:      "message-received",
				Namespace: namespace,
				SessionID: sessionID,
				Message:   syncengine.MessageEventData(msg),
			})
			if session, _ := s.deps.Store.GetSession(namespace, sessionID); session != nil {
				s.deps.Engine.HandleRealtimeEvent(syncengine.SyncEvent{
					Type:      "session-updated",
					Namespace: namespace,
					SessionID: sessionID,
					Data:      syncengine.SessionEventData(session),
				})
			}
		} else {
			s.publishMessage(namespace, sessionID, msg)
			if created {
				s.publishSessionAdded(namespace, sessionID)
			}
			s.publishSessionUpdated(namespace, sessionID)
		}
		s.emitUpdateEvent(sessionID, msg)
		return nil, false
	case "update-metadata":
		if sessionID == "" {
			return nil, false
		}
		created := false
		session, _ := s.deps.Store.GetSession(namespace, sessionID)
		if session == nil {
			if _, err := s.deps.Store.CreateSessionWithID(namespace, sessionID, nil, nil); err != nil {
				log.Printf("[SocketIO] Failed to create session %s: %v", sessionID, err)
			} else {
				created = true
			}
		}
		metadata, _ := data["metadata"].(map[string]any)
		expected := parseInt64(data["expectedVersion"])
		result, _ := s.deps.Store.UpdateSessionMetadata(namespace, sessionID, metadata, expected)
		if result.Result == "success" {
			if s.deps.Engine != nil {
				if created {
					if session, _ := s.deps.Store.GetSession(namespace, sessionID); session != nil {
						s.deps.Engine.HandleRealtimeEvent(syncengine.SyncEvent{
							Type:      "session-added",
							Namespace: namespace,
							SessionID: sessionID,
							Data:      syncengine.SessionEventData(session),
						})
					}
				}
				if session, _ := s.deps.Store.GetSession(namespace, sessionID); session != nil {
					s.deps.Engine.HandleRealtimeEvent(syncengine.SyncEvent{
						Type:      "session-updated",
						Namespace: namespace,
						SessionID: sessionID,
						Data:      syncengine.SessionEventData(session),
					})
				}
			} else {
				if created {
					s.publishSessionAdded(namespace, sessionID)
				}
				s.publishSessionUpdated(namespace, sessionID)
			}
			s.emitSessionUpdate(sessionID, map[string]any{
				"metadata": map[string]any{
					"version": result.Version,
					"value":   result.Value,
				},
				"agentState": nil,
			})
		}
		return map[string]any{
			"result":   result.Result,
			"version":  result.Version,
			"metadata": result.Value,
		}, true
	case "update-state":
		if sessionID == "" {
			return nil, false
		}
		created := false
		session, _ := s.deps.Store.GetSession(namespace, sessionID)
		if session == nil {
			if _, err := s.deps.Store.CreateSessionWithID(namespace, sessionID, nil, nil); err != nil {
				log.Printf("[SocketIO] Failed to create session %s: %v", sessionID, err)
			} else {
				created = true
			}
		}
		expected := parseInt64(data["expectedVersion"])
		result, _ := s.deps.Store.UpdateSessionAgentState(namespace, sessionID, data["agentState"], expected)
		if result.Result == "success" {
			if s.deps.Engine != nil {
				if created {
					if session, _ := s.deps.Store.GetSession(namespace, sessionID); session != nil {
						s.deps.Engine.HandleRealtimeEvent(syncengine.SyncEvent{
							Type:      "session-added",
							Namespace: namespace,
							SessionID: sessionID,
							Data:      syncengine.SessionEventData(session),
						})
					}
				}
				if session, _ := s.deps.Store.GetSession(namespace, sessionID); session != nil {
					s.deps.Engine.HandleRealtimeEvent(syncengine.SyncEvent{
						Type:      "session-updated",
						Namespace: namespace,
						SessionID: sessionID,
						Data:      syncengine.SessionEventData(session),
					})
				}
			} else {
				if created {
					s.publishSessionAdded(namespace, sessionID)
				}
				s.publishSessionUpdated(namespace, sessionID)
			}
			s.emitSessionUpdate(sessionID, map[string]any{
				"metadata": nil,
				"agentState": map[string]any{
					"version": result.Version,
					"value":   result.Value,
				},
			})
		}
		return map[string]any{
			"result":     result.Result,
			"version":    result.Version,
			"agentState": result.Value,
		}, true
	case "session-alive":
		if sessionID == "" {
			return nil, false
		}
		if s.deps.Engine != nil {
			aliveAt := parseInt64(data["time"])
			if aliveAt == 0 {
				aliveAt = time.Now().UnixMilli()
			}
			payload := syncengine.SessionAlivePayload{
				SessionID:      sessionID,
				Time:           aliveAt,
				Thinking:       data["thinking"] == true,
				PermissionMode: getString(data["permissionMode"]),
				ModelMode:      getString(data["modelMode"]),
				Namespace:      namespace,
			}
			s.deps.Engine.HandleSessionAlive(payload)
		} else {
			created := false
			session, _ := s.deps.Store.GetSession(namespace, sessionID)
			if session == nil {
				session, _ = s.deps.Store.CreateSessionWithID(namespace, sessionID, nil, nil)
				created = true
			}
			aliveAt := parseInt64(data["time"])
			if aliveAt == 0 {
				aliveAt = time.Now().UnixMilli()
			}
			session.Active = true
			session.ActiveAt = aliveAt
			session.Thinking, _ = data["thinking"].(bool)
			session.ThinkingAt = aliveAt
			if mode, ok := data["permissionMode"].(string); ok {
				session.PermissionMode = mode
			}
			if model, ok := data["modelMode"].(string); ok {
				session.ModelMode = model
			}
			session.UpdatedAt = time.Now().UnixMilli()
			_ = s.deps.Store.UpdateSession(namespace, session)
			if created {
				s.publishSessionAdded(namespace, sessionID)
			}
			s.publishSessionUpdated(namespace, sessionID)
		}
		return map[string]any{"ok": true}, true
	case "session-end":
		if sessionID == "" {
			return nil, false
		}
		if s.deps.Engine != nil {
			endedAt := parseInt64(data["time"])
			if endedAt == 0 {
				endedAt = time.Now().UnixMilli()
			}
			s.deps.Engine.HandleSessionEnd(syncengine.SessionEndPayload{
				SessionID: sessionID,
				Time:      endedAt,
				Namespace: namespace,
			})
		} else {
			session, _ := s.deps.Store.GetSession(namespace, sessionID)
			if session == nil {
				return nil, false
			}
			endedAt := parseInt64(data["time"])
			if endedAt == 0 {
				endedAt = time.Now().UnixMilli()
			}
			session.Active = false
			session.Thinking = false
			session.ThinkingAt = endedAt
			session.UpdatedAt = time.Now().UnixMilli()
			_ = s.deps.Store.UpdateSession(namespace, session)
			s.publishSessionUpdated(namespace, sessionID)
		}
		return nil, false
	case "machine-alive":
		machineID, _ := data["machineId"].(string)
		if machineID == "" {
			return nil, false
		}
		if s.deps.Engine != nil {
			aliveAt := parseInt64(data["time"])
			if aliveAt == 0 {
				aliveAt = time.Now().UnixMilli()
			}
			s.deps.Engine.HandleMachineAlive(syncengine.MachineAlivePayload{
				MachineID: machineID,
				Time:      aliveAt,
				Namespace: namespace,
			})
		} else {
			machine, _ := s.deps.Store.UpsertMachine(namespace, machineID, nil, nil)
			machine.Active = true
			aliveAt := parseInt64(data["time"])
			if aliveAt == 0 {
				aliveAt = time.Now().UnixMilli()
			}
			machine.ActiveAt = aliveAt
			s.publishMachineUpdated(namespace, machineID, machine)
		}
		return map[string]any{"ok": true}, true
	case "machine-update-metadata":
		machineID, _ := data["machineId"].(string)
		if machineID == "" {
			return nil, false
		}
		expected := parseInt64(data["expectedVersion"])
		result, _ := s.deps.Store.UpdateMachineMetadata(namespace, machineID, data["metadata"], expected)
		if result.Result == "success" {
			machine, _ := s.deps.Store.GetMachine(namespace, machineID)
			if s.deps.Engine != nil {
				if machine != nil {
					s.deps.Engine.HandleRealtimeEvent(syncengine.SyncEvent{
						Type:      "machine-updated",
						Namespace: namespace,
						MachineID: machineID,
						Data:      syncengine.MachineEventData(machine),
					})
				}
			} else {
				s.publishMachineUpdated(namespace, machineID, machine)
			}
			s.emitMachineUpdate(machineID, map[string]any{
				"metadata": map[string]any{
					"version": result.Version,
					"value":   result.Value,
				},
				"runnerState": nil,
			})
		}
		return map[string]any{
			"result":   result.Result,
			"version":  result.Version,
			"metadata": result.Value,
		}, true
	case "machine-update-state":
		machineID, _ := data["machineId"].(string)
		if machineID == "" {
			return nil, false
		}
		expected := parseInt64(data["expectedVersion"])
		result, _ := s.deps.Store.UpdateMachineRunnerState(namespace, machineID, data["runnerState"], expected)
		if result.Result == "success" {
			machine, _ := s.deps.Store.GetMachine(namespace, machineID)
			if s.deps.Engine != nil {
				if machine != nil {
					s.deps.Engine.HandleRealtimeEvent(syncengine.SyncEvent{
						Type:      "machine-updated",
						Namespace: namespace,
						MachineID: machineID,
						Data:      syncengine.MachineEventData(machine),
					})
				}
			} else {
				s.publishMachineUpdated(namespace, machineID, machine)
			}
			s.emitMachineUpdate(machineID, map[string]any{
				"metadata": nil,
				"runnerState": map[string]any{
					"version": result.Version,
					"value":   result.Value,
				},
			})
		}
		return map[string]any{
			"result":      result.Result,
			"version":     result.Version,
			"runnerState": result.Value,
		}, true
	case "ping":
		return map[string]any{}, true
	case "rpc-register", "rpc-unregister", "usage-report":
		return nil, false
	case "terminal:ready", "terminal:output", "terminal:exit", "terminal:error":
		if sessionID == "" || terminalID == "" {
			return nil, false
		}
		s.forwardTerminalFromCli(conn, namespace, sessionID, terminalID, event, data)
		return nil, false
	default:
		return nil, false
	}
}

func (s *Server) handleTerminalEvent(engineID string, conn *wsConn, event string, payload json.RawMessage) (any, bool) {
	var data map[string]any
	if err := json.Unmarshal(payload, &data); err != nil {
		return nil, false
	}

	sessionID, _ := data["sessionId"].(string)
	terminalID, _ := data["terminalId"].(string)
	if sessionID == "" || terminalID == "" {
		return nil, false
	}

	connNamespace := "default"
	if conn != nil && conn.hapiNS != "" {
		connNamespace = conn.hapiNS
	}

	switch event {
	case "terminal:create":
		cliConn := s.pickCliConn(connNamespace, sessionID)
		if cliConn == nil {
			s.SendToConn("/terminal", "terminal:error", map[string]any{
				"terminalId": terminalID,
				"message":    "CLI is not connected for this session.",
			}, engineID)
			return nil, false
		}

		if s.terminal != nil {
			if s.terminal.CountForSocket(engineID) >= s.terminal.maxPerSocket {
				s.SendToConn("/terminal", "terminal:error", map[string]any{
					"terminalId": terminalID,
					"message":    fmt.Sprintf("Too many terminals open (max %d).", s.terminal.maxPerSocket),
				}, engineID)
				return nil, false
			}
			if s.terminal.CountForSession(sessionID) >= s.terminal.maxPerSession {
				s.SendToConn("/terminal", "terminal:error", map[string]any{
					"terminalId": terminalID,
					"message":    fmt.Sprintf("Too many terminals open for this session (max %d).", s.terminal.maxPerSession),
				}, engineID)
				return nil, false
			}

			if entry, reason := s.terminal.Register(terminalID, sessionID, engineID, cliConn); entry == nil {
				message := "Terminal ID is already in use."
				switch reason {
				case "too_many_socket":
					message = fmt.Sprintf("Too many terminals open (max %d).", s.terminal.maxPerSocket)
				case "too_many_session":
					message = fmt.Sprintf("Too many terminals open for this session (max %d).", s.terminal.maxPerSession)
				case "invalid":
					message = "Invalid terminal request."
				}
				s.SendToConn("/terminal", "terminal:error", map[string]any{
					"terminalId": terminalID,
					"message":    message,
				}, engineID)
				return nil, false
			}
			s.terminal.MarkActivity(terminalID)
		}

		s.sendToWsConn(cliConn, "/cli", "terminal:open", data)
	case "terminal:write":
		entry := s.resolveTerminalEntry(engineID, terminalID)
		if entry == nil {
			s.SendToConn("/terminal", "terminal:error", map[string]any{
				"terminalId": terminalID,
				"message":    "Terminal not found.",
			}, engineID)
			return nil, false
		}
		s.sendToWsConn(entry.CliConn, "/cli", "terminal:write", map[string]any{
			"sessionId": entry.SessionID,
			"terminalId": terminalID,
			"data":      data["data"],
		})
		if s.terminal != nil {
			s.terminal.MarkActivity(terminalID)
		}
	case "terminal:resize":
		entry := s.resolveTerminalEntry(engineID, terminalID)
		if entry == nil {
			s.SendToConn("/terminal", "terminal:error", map[string]any{
				"terminalId": terminalID,
				"message":    "Terminal not found.",
			}, engineID)
			return nil, false
		}
		s.sendToWsConn(entry.CliConn, "/cli", "terminal:resize", map[string]any{
			"sessionId": entry.SessionID,
			"terminalId": terminalID,
			"cols":      data["cols"],
			"rows":      data["rows"],
		})
		if s.terminal != nil {
			s.terminal.MarkActivity(terminalID)
		}
	case "terminal:close":
		entry := s.resolveTerminalEntry(engineID, terminalID)
		if entry == nil {
			s.SendToConn("/terminal", "terminal:error", map[string]any{
				"terminalId": terminalID,
				"message":    "Terminal not found.",
			}, engineID)
			return nil, false
		}
		if s.terminal != nil {
			s.terminal.Remove(terminalID)
		}
		s.sendToWsConn(entry.CliConn, "/cli", "terminal:close", map[string]any{
			"sessionId": entry.SessionID,
			"terminalId": terminalID,
		})
	default:
		return nil, false
	}
	return nil, false
}

func (s *Server) resolveTerminalEntry(engineID string, terminalID string) *terminalEntry {
	if s == nil || s.terminal == nil {
		return nil
	}
	entry := s.terminal.Get(terminalID)
	if entry == nil {
		return nil
	}
	if entry.SocketID != engineID {
		return nil
	}
	return entry
}

func (s *Server) pickCliConn(namespace string, sessionID string) *wsConn {
	if s == nil || sessionID == "" {
		return nil
	}
	s.mu.RLock()
	conns := s.wsConns["/cli"]
	for conn := range conns {
		if conn == nil {
			continue
		}
		if conn.sessionID != sessionID {
			continue
		}
		if namespace != "" && conn.hapiNS != "" && conn.hapiNS != namespace {
			continue
		}
		s.mu.RUnlock()
		return conn
	}
	s.mu.RUnlock()
	return nil
}

func (s *Server) forwardTerminalFromCli(conn *wsConn, namespace string, sessionID string, terminalID string, event string, payload map[string]any) {
	if s == nil || s.terminal == nil {
		return
	}

	entry := s.terminal.Get(terminalID)
	if entry == nil {
		return
	}
	if entry.CliConn != conn {
		return
	}
	if entry.SessionID != sessionID {
		return
	}

	if s.terminal != nil {
		s.terminal.MarkActivity(terminalID)
	}

	webPayload := payload
	if event == "terminal:error" {
		webPayload = map[string]any{
			"terminalId": terminalID,
			"message":    payload["message"],
		}
	}

	if event == "terminal:exit" {
		if s.terminal != nil {
			s.terminal.Remove(terminalID)
		}
	}

	s.SendToConn("/terminal", event, webPayload, entry.SocketID)
}

func (s *Server) sendToWsConn(conn *wsConn, namespace string, event string, payload any) {
	if s == nil || conn == nil {
		return
	}
	packet := encodeSocketEvent(namespace, event, payload)
	_ = conn.writeText(string(EngineMessage) + packet)
}

func (s *Server) publishSessionUpdated(namespace string, sessionID string) {
	if s.deps.SSE == nil {
		return
	}
	session, _ := s.deps.Store.GetSession(namespace, sessionID)
	if session == nil {
		return
	}

	s.deps.SSE.Publish(sse.Event{
		Type: "session-updated",
		Data: map[string]any{
			"namespace": namespace,
			"sessionId": sessionID,
			"data": map[string]any{
				"id":                session.ID,
				"namespace":         session.Namespace,
				"seq":               session.Seq,
				"createdAt":         session.CreatedAt,
				"updatedAt":         session.UpdatedAt,
				"active":            session.Active,
				"activeAt":          session.ActiveAt,
				"metadata":          session.Metadata,
				"metadataVersion":   session.MetadataVersion,
				"agentState":        session.AgentState,
				"agentStateVersion": session.AgentStateVersion,
				"thinking":          session.Thinking,
				"thinkingAt":        session.ThinkingAt,
				"todos":             session.Todos,
				"permissionMode":    nullableString(session.PermissionMode),
				"modelMode":         nullableString(session.ModelMode),
			},
		},
	})
}

func (s *Server) publishSessionAdded(namespace string, sessionID string) {
	if s.deps.SSE == nil {
		return
	}
	session, _ := s.deps.Store.GetSession(namespace, sessionID)
	if session == nil {
		return
	}
	s.deps.SSE.Publish(sse.Event{
		Type: "session-added",
		Data: map[string]any{
			"namespace": namespace,
			"sessionId": sessionID,
			"data": map[string]any{
				"id":                session.ID,
				"namespace":         session.Namespace,
				"seq":               session.Seq,
				"createdAt":         session.CreatedAt,
				"updatedAt":         session.UpdatedAt,
				"active":            session.Active,
				"activeAt":          session.ActiveAt,
				"metadata":          session.Metadata,
				"metadataVersion":   session.MetadataVersion,
				"agentState":        session.AgentState,
				"agentStateVersion": session.AgentStateVersion,
				"thinking":          session.Thinking,
				"thinkingAt":        session.ThinkingAt,
				"todos":             session.Todos,
				"permissionMode":    nullableString(session.PermissionMode),
				"modelMode":         nullableString(session.ModelMode),
			},
		},
	})
}

func (s *Server) publishMessage(namespace string, sessionID string, msg store.Message) {
	if s.deps.SSE == nil {
		return
	}
	message := map[string]any{
		"id":        msg.ID,
		"seq":       msg.Seq,
		"content":   msg.Content,
		"createdAt": msg.CreatedAt,
	}
	if msg.LocalID != "" {
		message["localId"] = msg.LocalID
	} else {
		message["localId"] = nil
	}
	s.deps.SSE.Publish(sse.Event{
		Type: "message-received",
		Data: map[string]any{
			"namespace": namespace,
			"sessionId": sessionID,
			"message":   message,
		},
	})
}

func (s *Server) publishMachineUpdated(namespace string, machineID string, machine *store.Machine) {
	if s.deps.SSE == nil || machine == nil {
		return
	}
	s.deps.SSE.Publish(sse.Event{
		Type: "machine-updated",
		Data: map[string]any{
			"namespace": namespace,
			"machineId": machineID,
			"data": map[string]any{
				"id":                 machine.ID,
				"namespace":          machine.Namespace,
				"createdAt":          machine.CreatedAt,
				"updatedAt":          machine.UpdatedAt,
				"metadata":           machine.Metadata,
				"metadataVersion":    machine.MetadataVersion,
				"runnerState":        machine.RunnerState,
				"runnerStateVersion": machine.RunnerStateVersion,
				"active":             machine.Active,
				"activeAt":           machine.ActiveAt,
				"seq":                machine.Seq,
			},
		},
	})
}

func (s *Server) emitUpdateEvent(sessionID string, msg store.Message) {
	if sessionID == "" || s.deps.Send == nil {
		return
	}
	update := map[string]any{
		"id":        newSID(),
		"seq":       msg.Seq,
		"createdAt": time.Now().UnixMilli(),
		"body": map[string]any{
			"t":   "new-message",
			"sid": sessionID,
			"message": map[string]any{
				"id":        msg.ID,
				"seq":       msg.Seq,
				"createdAt": msg.CreatedAt,
				"localId":   nullableString(msg.LocalID),
				"content":   msg.Content,
			},
		},
	}
	s.SendToSession("/cli", "update", update, sessionID)
}

func (s *Server) emitSessionUpdate(sessionID string, updateBody map[string]any) {
	if sessionID == "" || s.deps.Send == nil {
		return
	}
	payload := map[string]any{
		"id":        newSID(),
		"seq":       time.Now().UnixMilli(),
		"createdAt": time.Now().UnixMilli(),
		"body": map[string]any{
			"t":          "update-session",
			"sid":        sessionID,
			"metadata":   updateBody["metadata"],
			"agentState": updateBody["agentState"],
		},
	}
	s.SendToSession("/cli", "update", payload, sessionID)
}

func (s *Server) emitMachineUpdate(machineID string, updateBody map[string]any) {
	if machineID == "" || s.deps.Send == nil {
		return
	}
	payload := map[string]any{
		"id":        newSID(),
		"seq":       time.Now().UnixMilli(),
		"createdAt": time.Now().UnixMilli(),
		"body": map[string]any{
			"t":           "update-machine",
			"machineId":   machineID,
			"metadata":    updateBody["metadata"],
			"runnerState": updateBody["runnerState"],
		},
	}
	s.SendToMachine("/cli", "update", payload, machineID)
}

func (s *Server) sendTerminalEvent(sessionID string, event string, payload any) {
	if sessionID == "" {
		return
	}
	s.SendToSession("/terminal", event, payload, sessionID)
}

func parseInt64(value any) int64 {
	switch v := value.(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	case json.Number:
		parsed, _ := v.Int64()
		return parsed
	default:
		return 0
	}
}

func getString(value any) string {
	if value == nil {
		return ""
	}
	if s, ok := value.(string); ok {
		return s
	}
	return ""
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func parseMessageContent(raw any) any {
	if raw == nil {
		return nil
	}
	if text, ok := raw.(string); ok {
		var parsed any
		if err := json.Unmarshal([]byte(text), &parsed); err == nil {
			return parsed
		}
		return text
	}
	return raw
}

func parseRpcMethod(payload json.RawMessage) (string, bool) {
	if len(payload) == 0 {
		return "", false
	}
	var data map[string]any
	if err := json.Unmarshal(payload, &data); err != nil {
		return "", false
	}
	method, _ := data["method"].(string)
	if method == "" {
		return "", false
	}
	return method, true
}
