package httpserver

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"hub_go/internal/auth"
	"hub_go/internal/config"
	"hub_go/internal/socketio"
	"hub_go/internal/sse"
	"hub_go/internal/store"
	syncengine "hub_go/internal/sync"
	"hub_go/internal/telegram"
	"hub_go/internal/voice"
)

type AuthDependencies struct {
	JWTSecret      []byte
	CliApiToken    string
	TelegramToken  *string
	DataDir        string
	Store          *store.Store
	Engine         *syncengine.Engine
	SSEBus         *sse.Bus
	Visibility     *sse.VisibilityTracker
	SocketIO       *socketio.Server
	CorsOrigins    []string
	VapidPublicKey string
}

func RegisterRoutes(router *Router, deps AuthDependencies) {
	authMiddleware := AuthMiddleware(deps.JWTSecret)
	cliMiddleware := CliAuthMiddleware(deps.CliApiToken)
	cors := CORSMiddleware(CORSConfig{Origins: deps.CorsOrigins})

	router.Handle(http.MethodGet, "/healthz", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}, cors))

	router.Handle(http.MethodGet, "/health", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "protocolVersion": 1})
	}, cors))

	router.Handle(http.MethodGet, "/socket.io/", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		deps.SocketIO.Handle(w, req)
	}, cors))

	router.Handle(http.MethodPost, "/socket.io/", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		deps.SocketIO.Handle(w, req)
	}, cors))

	router.Handle(http.MethodGet, "/socket.io", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		deps.SocketIO.Handle(w, req)
	}, cors))

	router.Handle(http.MethodPost, "/socket.io", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		deps.SocketIO.Handle(w, req)
	}, cors))

	router.Handle(http.MethodPost, "/api/auth", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		body, err := decodeJSON(req)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}

		if accessToken, ok := body["accessToken"].(string); ok {
			parsed := auth.ParseAccessToken(accessToken)
			if parsed == nil || !auth.ConstantTimeEquals(parsed.BaseToken, deps.CliApiToken) {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid access token"})
				return
			}

			ownerID, err := config.LoadOrCreateOwnerID(deps.DataDir)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to load owner id"})
				return
			}

			token, err := signJWT(deps.JWTSecret, ownerID, parsed.Namespace)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to sign token"})
				return
			}

			writeJSON(w, http.StatusOK, map[string]any{
				"token": token,
				"user": map[string]any{
					"id":        ownerID,
					"firstName": "Web User",
				},
			})
			return
		}

		if initData, ok := body["initData"].(string); ok {
			if deps.TelegramToken == nil || *deps.TelegramToken == "" {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{
					"error": "Telegram authentication is disabled. Configure TELEGRAM_BOT_TOKEN.",
				})
				return
			}

			result := telegram.ValidateInitData(initData, *deps.TelegramToken, 24*time.Hour)
			if !result.OK {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": result.Error})
				return
			}

			platformUserID := strconv.FormatInt(result.User.ID, 10)
			stored, err := deps.Store.GetUser("telegram", platformUserID)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to load user"})
				return
			}
			if stored == nil {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "not_bound"})
				return
			}

			ownerID, err := config.LoadOrCreateOwnerID(deps.DataDir)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to load owner id"})
				return
			}

			token, err := signJWT(deps.JWTSecret, ownerID, stored.Namespace)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to sign token"})
				return
			}

			writeJSON(w, http.StatusOK, map[string]any{
				"token": token,
				"user": map[string]any{
					"id":        ownerID,
					"username":  result.User.Username,
					"firstName": result.User.FirstName,
					"lastName":  result.User.LastName,
				},
			})
			return
		}

		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
	}, cors))

	router.Handle(http.MethodPost, "/api/bind", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		body, err := decodeJSON(req)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}

		accessToken, okToken := body["accessToken"].(string)
		initData, okInit := body["initData"].(string)
		if !okToken || !okInit || initData == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}

		parsed := auth.ParseAccessToken(accessToken)
		if parsed == nil || !auth.ConstantTimeEquals(parsed.BaseToken, deps.CliApiToken) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid access token"})
			return
		}

		if deps.TelegramToken == nil || *deps.TelegramToken == "" {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{
				"error": "Telegram authentication is disabled. Configure TELEGRAM_BOT_TOKEN.",
			})
			return
		}

		result := telegram.ValidateInitData(initData, *deps.TelegramToken, 24*time.Hour)
		if !result.OK {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": result.Error})
			return
		}

		platformUserID := strconv.FormatInt(result.User.ID, 10)
		existing, err := deps.Store.GetUser("telegram", platformUserID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to load user"})
			return
		}
		if existing != nil && existing.Namespace != parsed.Namespace {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "already_bound"})
			return
		}

		if existing == nil {
			if _, err := deps.Store.AddUser("telegram", platformUserID, parsed.Namespace); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to bind user"})
				return
			}
		}

		ownerID, err := config.LoadOrCreateOwnerID(deps.DataDir)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to load owner id"})
			return
		}

		token, err := signJWT(deps.JWTSecret, ownerID, parsed.Namespace)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to sign token"})
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"token": token,
			"user": map[string]any{
				"id":        ownerID,
				"username":  result.User.Username,
				"firstName": result.User.FirstName,
				"lastName":  result.User.LastName,
			},
		})
	}, cors))

	router.Handle(http.MethodGet, "/api/events", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		query := req.URL.Query()
		if sessionID := query.Get("sessionId"); sessionID != "" {
			if _, ok := requireSession(w, deps.Store, deps.Engine, namespace, sessionID); !ok {
				return
			}
		}
		if machineID := query.Get("machineId"); machineID != "" {
			if _, ok := requireMachine(w, deps.Store, deps.Engine, namespace, machineID); !ok {
				return
			}
		}
		all := parseBool(query.Get("all"))
		visibility := "hidden"
		if query.Get("visibility") == "visible" {
			visibility = "visible"
		}
		sse.HandleEvents(w, req, deps.SSEBus, deps.Visibility, namespace, all, visibility)
	}, cors, authMiddleware))

	router.Handle(http.MethodGet, "/api/sessions", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		var sessions []store.Session
		if deps.Engine != nil {
			sessions = deps.Engine.GetSessionsByNamespace(namespace)
		} else {
			sessions = deps.Store.ListSessions(namespace)
		}
		sort.Slice(sessions, func(i, j int) bool {
			a := sessions[i]
			b := sessions[j]
			if a.Active != b.Active {
				return a.Active
			}
			if a.Active {
				aPending := countPendingRequests(a.AgentState)
				bPending := countPendingRequests(b.AgentState)
				if aPending != bPending {
					return aPending > bPending
				}
			}
			return a.UpdatedAt > b.UpdatedAt
		})
		response := make([]map[string]any, 0, len(sessions))
		for _, session := range sessions {
			pendingCount := countPendingRequests(session.AgentState)
			todoProgress := computeTodoProgress(session.Todos)
			response = append(response, map[string]any{
				"id":                   session.ID,
				"active":               session.Active,
				"thinking":             session.Thinking,
				"activeAt":             session.ActiveAt,
				"updatedAt":            session.UpdatedAt,
				"metadata":             session.Metadata,
				"todoProgress":         todoProgress,
				"pendingRequestsCount": pendingCount,
				"modelMode":            nullableStringToValue(session.ModelMode),
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"sessions": response})
	}, cors, authMiddleware))

	router.Handle(http.MethodGet, "/api/sessions/:id", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"session": map[string]any{
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
				"permissionMode":    nullableStringToValue(session.PermissionMode),
				"modelMode":         nullableStringToValue(session.ModelMode),
			},
		})
	}, cors, authMiddleware))

	router.Handle(http.MethodGet, "/api/sessions/:id/messages", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}

		limit := parseLimitQuery(req, "limit", 50, 200)
		beforeSeq, hasBefore := parseOptionalIntQueryMin(req, "beforeSeq", 1)
		beforeValue := int64(0)
		if hasBefore {
			beforeValue = beforeSeq
		}
		var messages []store.Message
		if deps.Engine != nil {
			page := deps.Engine.GetMessagesPage(session.ID, limit, beforeValue)
			messages = page.Messages
		} else {
			messages = deps.Store.ListMessages(session.ID, beforeValue, limit)
		}
		response := make([]map[string]any, 0, len(messages))
		oldestSeq := int64(0)
		for _, msg := range messages {
			if oldestSeq == 0 || msg.Seq < oldestSeq {
				oldestSeq = msg.Seq
			}
			entry := map[string]any{
				"id":        msg.ID,
				"content":   msg.Content,
				"createdAt": msg.CreatedAt,
				"seq":       msg.Seq,
			}
			if msg.LocalID != "" {
				entry["localId"] = msg.LocalID
			}
			response = append(response, entry)
		}
		nextBeforeSeq := any(nil)
		hasMore := false
		if oldestSeq > 0 {
			nextBeforeSeq = oldestSeq
			if deps.Engine != nil {
				hasMore = len(deps.Engine.GetMessagesPage(session.ID, 1, oldestSeq).Messages) > 0
			} else {
				hasMore = len(deps.Store.ListMessages(session.ID, oldestSeq, 1)) > 0
			}
		}
		beforeSeqOut := any(nil)
		if hasBefore {
			beforeSeqOut = beforeSeq
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"messages": response,
			"page": map[string]any{
				"limit":         limit,
				"beforeSeq":     beforeSeqOut,
				"nextBeforeSeq": nextBeforeSeq,
				"hasMore":       hasMore,
			},
		})
	}, cors, authMiddleware))

	router.Handle(http.MethodPost, "/api/sessions/:id/messages", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		if !session.Active {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "Session is inactive"})
			return
		}

		body, err := decodeJSON(req)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		text, _ := body["text"].(string)
		attachments := body["attachments"]
		localID, _ := body["localId"].(string)
		if text == "" && attachmentsEmpty(attachments) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Message requires text or attachments"})
			return
		}
		content := map[string]any{
			"role": "user",
			"content": map[string]any{
				"type":        "text",
				"text":        text,
				"attachments": attachments,
			},
			"meta": map[string]any{
				"sentFrom": "webapp",
			},
		}
		message := deps.Store.AddMessage(session.ID, content, localID)
		if deps.Engine != nil {
			deps.Engine.HandleRealtimeEvent(syncengine.SyncEvent{
				Type:      "message-received",
				Namespace: namespace,
				SessionID: session.ID,
				Message:   syncengine.MessageEventData(message),
			})
		} else {
			deps.SSEBus.Publish(sse.Event{
				Type: "message-received",
				Data: map[string]any{
					"namespace": namespace,
					"sessionId": session.ID,
					"message":   messageToEvent(message),
				},
			})
		}
		deps.SocketIO.Send("/cli", "update", map[string]any{
			"id":        newUpdateID(),
			"seq":       message.Seq,
			"createdAt": time.Now().UnixMilli(),
			"body": map[string]any{
				"t":   "new-message",
				"sid": session.ID,
				"message": map[string]any{
					"id":        message.ID,
					"seq":       message.Seq,
					"createdAt": message.CreatedAt,
					"localId":   nullableStringToValue(message.LocalID),
					"content":   message.Content,
				},
			},
		})
		if updated, err := deps.Store.GetSession(namespace, session.ID); err == nil && updated != nil {
			if deps.Engine != nil {
				deps.Engine.HandleRealtimeEvent(syncengine.SyncEvent{
					Type:      "session-updated",
					Namespace: namespace,
					SessionID: updated.ID,
					Data:      syncengine.SessionEventData(updated),
				})
			} else {
				deps.SSEBus.Publish(sse.Event{
					Type: "session-updated",
					Data: map[string]any{
						"namespace": namespace,
						"sessionId": updated.ID,
						"data":      sessionToPayload(updated),
					},
				})
			}
		}

		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}, cors, authMiddleware))

	router.Handle(http.MethodPost, "/api/sessions/:id/resume", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		if session.Active {
			writeJSON(w, http.StatusOK, map[string]any{"type": "success", "sessionId": session.ID})
			return
		}
		path := getMetadataString(session.Metadata, "path", "")
		if path == "" {
			writeJSON(w, http.StatusInternalServerError, map[string]any{
				"error": "Session metadata missing path",
				"code":  "resume_unavailable",
			})
			return
		}
		flavor := getMetadataString(session.Metadata, "flavor", "claude")
		resumeToken := ""
		switch flavor {
		case "codex":
			resumeToken = getMetadataString(session.Metadata, "codexSessionId", "")
		case "gemini":
			resumeToken = getMetadataString(session.Metadata, "geminiSessionId", "")
		case "opencode":
			resumeToken = getMetadataString(session.Metadata, "opencodeSessionId", "")
		default:
			flavor = "claude"
			resumeToken = getMetadataString(session.Metadata, "claudeSessionId", "")
		}
		if resumeToken == "" {
			writeJSON(w, http.StatusInternalServerError, map[string]any{
				"error": "Resume session ID unavailable",
				"code":  "resume_unavailable",
			})
			return
		}
		machine := selectResumeMachine(deps.Store.ListMachines(namespace), session.Metadata)
		if machine == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{
				"error": "No machine online",
				"code":  "no_machine_online",
			})
			return
		}
		result, err := rpcCallUnified(deps.Engine, deps.SocketIO, machine.ID, "spawn-happy-session", map[string]any{
			"type":            "spawn-in-directory",
			"directory":       path,
			"agent":           flavor,
			"resumeSessionId": resumeToken,
		})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{
				"error": err.Error(),
				"code":  "resume_failed",
			})
			return
		}
		spawn := normalizeSpawnResponse(result)
		if spawn["type"] != "success" {
			writeJSON(w, http.StatusInternalServerError, map[string]any{
				"error": spawn["message"],
				"code":  "resume_failed",
			})
			return
		}
		sessionID, _ := spawn["sessionId"].(string)
		if sessionID == "" {
			sessionID = session.ID
		}
		if !waitForSessionActive(deps.Store, namespace, sessionID, 15*time.Second) {
			writeJSON(w, http.StatusInternalServerError, map[string]any{
				"error": "Session failed to become active",
				"code":  "resume_failed",
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"type": "success", "sessionId": sessionID})
	}, cors, authMiddleware))

	router.Handle(http.MethodPost, "/api/sessions/:id/abort", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		if !session.Active {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "Session is inactive"})
			return
		}
		_, err := rpcCallUnified(deps.Engine, deps.SocketIO, session.ID, "abort", map[string]any{
			"reason": "User aborted via Web",
		})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}, cors, authMiddleware))

	router.Handle(http.MethodPost, "/api/sessions/:id/archive", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		if !session.Active {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "Session is inactive"})
			return
		}
		_, err := rpcCallUnified(deps.Engine, deps.SocketIO, session.ID, "killSession", map[string]any{})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}, cors, authMiddleware))

	router.Handle(http.MethodPost, "/api/sessions/:id/switch", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		if !session.Active {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "Session is inactive"})
			return
		}
		_, err := rpcCallUnified(deps.Engine, deps.SocketIO, session.ID, "switch", map[string]any{
			"to": "remote",
		})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}, cors, authMiddleware))

	router.Handle(http.MethodPatch, "/api/sessions/:id", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		body, err := decodeJSON(req)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		name, _ := body["name"].(string)
		if session.Metadata == nil {
			session.Metadata = map[string]any{}
		}
		if name != "" {
			session.Metadata["name"] = name
		}
		session.UpdatedAt = time.Now().UnixMilli()
		_ = deps.Store.UpdateSession(namespace, session)
		if deps.Engine != nil {
			deps.Engine.HandleRealtimeEvent(syncengine.SyncEvent{
				Type:      "session-updated",
				Namespace: namespace,
				SessionID: session.ID,
				Data:      syncengine.SessionEventData(session),
			})
		} else {
			deps.SSEBus.Publish(sse.Event{
				Type: "session-updated",
				Data: map[string]any{
					"namespace": namespace,
					"sessionId": session.ID,
					"data":      sessionToPayload(session),
				},
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}, cors, authMiddleware))

	router.Handle(http.MethodDelete, "/api/sessions/:id", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		if !deps.Store.DeleteSession(namespace, params["id"]) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "Session not found"})
			return
		}
		if deps.Engine != nil {
			deps.Engine.HandleRealtimeEvent(syncengine.SyncEvent{
				Type:      "session-removed",
				Namespace: namespace,
				SessionID: params["id"],
			})
		} else {
			deps.SSEBus.Publish(sse.Event{
				Type: "session-removed",
				Data: map[string]any{
					"namespace": namespace,
					"sessionId": params["id"],
				},
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}, cors, authMiddleware))

	router.Handle(http.MethodPost, "/api/sessions/:id/permission-mode", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		if !session.Active {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "Session is inactive"})
			return
		}
		body, err := decodeJSON(req)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		mode, _ := body["mode"].(string)
		if mode == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		_, _ = rpcCallUnified(deps.Engine, deps.SocketIO, session.ID, "set-session-config", map[string]any{
			"permissionMode": mode,
		})
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}, cors, authMiddleware))

	router.Handle(http.MethodPost, "/api/sessions/:id/model", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		if !session.Active {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "Session is inactive"})
			return
		}
		body, err := decodeJSON(req)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		model, _ := body["model"].(string)
		if model == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		_, _ = rpcCallUnified(deps.Engine, deps.SocketIO, session.ID, "set-session-config", map[string]any{
			"modelMode": model,
		})
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}, cors, authMiddleware))

	router.Handle(http.MethodGet, "/api/sessions/:id/slash-commands", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		agent := getMetadataString(session.Metadata, "flavor", "claude")
		result, err := rpcCallUnified(deps.Engine, deps.SocketIO, session.ID, "listSlashCommands", map[string]any{
			"agent": agent,
		})
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, result)
	}, cors, authMiddleware))

	router.Handle(http.MethodGet, "/api/sessions/:id/skills", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		result, err := rpcCallUnified(deps.Engine, deps.SocketIO, session.ID, "listSkills", map[string]any{})
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, result)
	}, cors, authMiddleware))

	router.Handle(http.MethodPost, "/api/sessions/:id/upload", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		if !session.Active {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "Session is inactive"})
			return
		}
		body, err := decodeJSON(req)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		filename, _ := body["filename"].(string)
		content, _ := body["content"].(string)
		mimeType, _ := body["mimeType"].(string)
		if filename == "" || content == "" || mimeType == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		if estimateBase64Bytes(content) > 50*1024*1024 {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"success": false, "error": "File too large (max 50MB)"})
			return
		}
		result, err := rpcCallUnified(deps.Engine, deps.SocketIO, session.ID, "uploadFile", map[string]any{
			"sessionId": session.ID,
			"filename":  filename,
			"content":   content,
			"mimeType":  mimeType,
		})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, result)
	}, cors, authMiddleware))

	router.Handle(http.MethodPost, "/api/sessions/:id/upload/delete", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		if !session.Active {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "Session is inactive"})
			return
		}
		body, err := decodeJSON(req)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		path, _ := body["path"].(string)
		if path == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		result, err := rpcCallUnified(deps.Engine, deps.SocketIO, session.ID, "deleteUpload", map[string]any{
			"sessionId": session.ID,
			"path":      path,
		})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, result)
	}, cors, authMiddleware))

	router.Handle(http.MethodPost, "/api/sessions/:id/permissions/:requestId/approve", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		if !session.Active {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "Session is inactive"})
			return
		}
		if !hasPendingRequest(session, params["requestId"]) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "Request not found"})
			return
		}
		body, err := decodeJSON(req)
		if err != nil && err.Error() != "empty payload" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		mode, _ := body["mode"].(string)
		allowTools := toStringSlice(body["allowTools"])
		decision, _ := body["decision"].(string)
		answers := body["answers"]
		_, err = rpcCallUnified(deps.Engine, deps.SocketIO, session.ID, "permission", map[string]any{
			"id":         params["requestId"],
			"approved":   true,
			"mode":       emptyToNil(mode),
			"allowTools": allowToolsOrNil(allowTools),
			"decision":   emptyToNil(decision),
			"answers":    answers,
		})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}, cors, authMiddleware))

	router.Handle(http.MethodPost, "/api/sessions/:id/permissions/:requestId/deny", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		if !session.Active {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "Session is inactive"})
			return
		}
		if !hasPendingRequest(session, params["requestId"]) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "Request not found"})
			return
		}
		body, err := decodeJSON(req)
		if err != nil && err.Error() != "empty payload" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		decision, _ := body["decision"].(string)
		_, err = rpcCallUnified(deps.Engine, deps.SocketIO, session.ID, "permission", map[string]any{
			"id":       params["requestId"],
			"approved": false,
			"decision": emptyToNil(decision),
		})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}, cors, authMiddleware))

	router.Handle(http.MethodGet, "/api/sessions/:id/git-status", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		sessionPath := getMetadataString(session.Metadata, "path", "")
		if sessionPath == "" {
			writeJSON(w, http.StatusOK, map[string]any{"success": false, "error": "Session path not available"})
			return
		}
		result, err := rpcCallUnified(deps.Engine, deps.SocketIO, session.ID, "git-status", map[string]any{
			"cwd": sessionPath,
		})
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, result)
	}, cors, authMiddleware))

	router.Handle(http.MethodGet, "/api/sessions/:id/git-diff-numstat", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		sessionPath := getMetadataString(session.Metadata, "path", "")
		if sessionPath == "" {
			writeJSON(w, http.StatusOK, map[string]any{"success": false, "error": "Session path not available"})
			return
		}
		staged := parseBoolQuery(req, "staged")
		result, err := rpcCallUnified(deps.Engine, deps.SocketIO, session.ID, "git-diff-numstat", map[string]any{
			"cwd":    sessionPath,
			"staged": staged,
		})
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, result)
	}, cors, authMiddleware))

	router.Handle(http.MethodGet, "/api/sessions/:id/git-diff-file", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		sessionPath := getMetadataString(session.Metadata, "path", "")
		if sessionPath == "" {
			writeJSON(w, http.StatusOK, map[string]any{"success": false, "error": "Session path not available"})
			return
		}
		filePath := req.URL.Query().Get("path")
		if filePath == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid file path"})
			return
		}
		staged := parseBoolQuery(req, "staged")
		result, err := rpcCallUnified(deps.Engine, deps.SocketIO, session.ID, "git-diff-file", map[string]any{
			"cwd":      sessionPath,
			"filePath": filePath,
			"staged":   staged,
		})
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, result)
	}, cors, authMiddleware))

	router.Handle(http.MethodGet, "/api/sessions/:id/file", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		sessionPath := getMetadataString(session.Metadata, "path", "")
		if sessionPath == "" {
			writeJSON(w, http.StatusOK, map[string]any{"success": false, "error": "Session path not available"})
			return
		}
		filePath := req.URL.Query().Get("path")
		if filePath == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid file path"})
			return
		}
		result, err := rpcCallUnified(deps.Engine, deps.SocketIO, session.ID, "readFile", map[string]any{
			"path": filePath,
		})
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, result)
	}, cors, authMiddleware))

	router.Handle(http.MethodGet, "/api/sessions/:id/files", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		sessionPath := getMetadataString(session.Metadata, "path", "")
		if sessionPath == "" {
			writeJSON(w, http.StatusOK, map[string]any{"success": false, "error": "Session path not available"})
			return
		}
		query := strings.TrimSpace(req.URL.Query().Get("query"))
		limit := parseLimitQuery(req, "limit", 200, 500)
		args := []string{"--files"}
		if query != "" {
			args = append(args, "--iglob", "*"+query+"*")
		}
		result, err := rpcCallUnified(deps.Engine, deps.SocketIO, session.ID, "ripgrep", map[string]any{
			"args": args,
			"cwd":  sessionPath,
		})
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"success": false, "error": err.Error()})
			return
		}
		mapped := mapRipgrepFiles(result, limit)
		writeJSON(w, http.StatusOK, mapped)
	}, cors, authMiddleware))

	router.Handle(http.MethodGet, "/api/machines", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		var machines []store.Machine
		if deps.Engine != nil {
			machines = deps.Engine.GetMachinesByNamespace(namespace)
		} else {
			machines = deps.Store.ListMachines(namespace)
		}
		response := make([]map[string]any, 0, len(machines))
		for _, machine := range machines {
			if !machine.Active {
				continue
			}
			response = append(response, map[string]any{
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
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"machines": response})
	}, cors, authMiddleware))

	router.Handle(http.MethodGet, "/api/push/vapid-public-key", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		writeJSON(w, http.StatusOK, map[string]any{"publicKey": deps.VapidPublicKey})
	}, cors, authMiddleware))

	router.Handle(http.MethodPost, "/api/machines/:id/spawn", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		machine, ok := requireMachine(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		body, err := decodeJSON(req)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		directory, _ := body["directory"].(string)
		if directory == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		agent, _ := body["agent"].(string)
		model, _ := body["model"].(string)
		sessionType, _ := body["sessionType"].(string)
		worktreeName, _ := body["worktreeName"].(string)
		yolo, _ := body["yolo"].(bool)
		result, err := rpcCallUnified(deps.Engine, deps.SocketIO, machine.ID, "spawn-happy-session", map[string]any{
			"type":         "spawn-in-directory",
			"directory":    directory,
			"agent":        emptyToNil(agent),
			"model":        emptyToNil(model),
			"yolo":         yolo,
			"sessionType":  emptyToNil(sessionType),
			"worktreeName": emptyToNil(worktreeName),
		})
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"type": "error", "message": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, normalizeSpawnResponse(result))
	}, cors, authMiddleware))

	router.Handle(http.MethodPost, "/api/machines/:id/paths/exists", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		machine, ok := requireMachine(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		body, err := decodeJSON(req)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		paths := uniqueStrings(toStringSlice(body["paths"]))
		if len(paths) == 0 {
			writeJSON(w, http.StatusOK, map[string]any{"exists": map[string]bool{}})
			return
		}
		result, err := rpcCallUnified(deps.Engine, deps.SocketIO, machine.ID, "path-exists", map[string]any{
			"paths": paths,
		})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, normalizePathExists(result))
	}, cors, authMiddleware))

	router.Handle(http.MethodPost, "/api/push/subscribe", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		body, err := decodeJSON(req)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		endpoint, _ := body["endpoint"].(string)
		keys, _ := body["keys"].(map[string]any)
		p256dh, _ := keys["p256dh"].(string)
		authKey, _ := keys["auth"].(string)
		if endpoint == "" || p256dh == "" || authKey == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		namespace := namespaceFromRequest(req)
		if err := deps.Store.UpsertPushSubscription(namespace, endpoint, p256dh, authKey); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to save subscription"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}, cors, authMiddleware))

	router.Handle(http.MethodDelete, "/api/push/subscribe", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		body, err := decodeJSON(req)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		endpoint, _ := body["endpoint"].(string)
		if endpoint == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		namespace := namespaceFromRequest(req)
		if err := deps.Store.DeletePushSubscription(namespace, endpoint); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to delete subscription"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}, cors, authMiddleware))

	router.Handle(http.MethodPost, "/api/voice/token", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		body, err := decodeJSONOptional(req)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"allowed": false, "error": "Invalid request body"})
			return
		}
		customAgentID, _ := body["customAgentId"].(string)
		customAPIKey, _ := body["customApiKey"].(string)
		apiKey := customAPIKey
		if apiKey == "" {
			apiKey = os.Getenv("ELEVENLABS_API_KEY")
		}
		agentID := customAgentID
		if agentID == "" {
			agentID = os.Getenv("ELEVENLABS_AGENT_ID")
		}
		if apiKey == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"allowed": false,
				"error":   "ElevenLabs API key not configured",
			})
			return
		}
		if agentID == "" {
			agentID, err = voice.GetOrCreateAgentID(apiKey)
			if err != nil || agentID == "" {
				writeJSON(w, http.StatusInternalServerError, map[string]any{
					"allowed": false,
					"error":   "Failed to create ElevenLabs agent automatically",
				})
				return
			}
		}
		token, err := voice.FetchConversationToken(apiKey, agentID)
		if err != nil {
			message := err.Error()
			if message == "" {
				message = "Unable to connect. Is the computer able to access the url?"
			}
			if strings.Contains(strings.ToLower(message), "connect") ||
				strings.Contains(strings.ToLower(message), "timeout") ||
				strings.Contains(strings.ToLower(message), "refused") {
				message = "Unable to connect. Is the computer able to access the url?"
			}
			writeJSON(w, http.StatusInternalServerError, map[string]any{
				"allowed": false,
				"error":   message,
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"allowed": true,
			"token":   token,
			"agentId": agentID,
		})
	}, cors, authMiddleware))

	router.Handle(http.MethodPost, "/api/visibility", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		if deps.Visibility == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Not connected"})
			return
		}
		body, err := decodeJSON(req)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		subscriptionID, _ := body["subscriptionId"].(string)
		visibility, _ := body["visibility"].(string)
		if subscriptionID == "" || (visibility != "visible" && visibility != "hidden") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		if !deps.Visibility.SetVisibility(subscriptionID, namespaceFromRequest(req), visibility) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "Subscription not found"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}, cors, authMiddleware))

	router.Handle(http.MethodPost, "/cli/sessions", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		body, err := decodeJSON(req)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		tag, _ := body["tag"].(string)
		if tag == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		namespace := namespaceFromRequest(req)
		metadata, _ := body["metadata"].(map[string]any)
		agentState := body["agentState"]
		session, err := deps.Store.CreateSession(namespace, metadata, agentState)
		if session != nil {
			session.Tag = tag
			_ = deps.Store.UpdateSession(namespace, session)
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to create session"})
			return
		}
		if deps.Engine != nil {
			deps.Engine.HandleRealtimeEvent(syncengine.SyncEvent{
				Type:      "session-added",
				Namespace: namespace,
				SessionID: session.ID,
				Data:      syncengine.SessionEventData(session),
			})
		} else {
			deps.SSEBus.Publish(sse.Event{
				Type: "session-added",
				Data: map[string]any{
					"namespace": namespace,
					"sessionId": session.ID,
					"data":      sessionToPayload(session),
				},
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"session": sessionToPayload(session)})
	}, cors, cliMiddleware))

	router.Handle(http.MethodGet, "/cli/sessions/:id", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"session": sessionToPayload(session)})
	}, cors, cliMiddleware))

	router.Handle(http.MethodGet, "/cli/sessions/:id/messages", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		session, ok := requireSession(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		afterSeq, hasAfter := parseOptionalIntQueryMin(req, "afterSeq", 0)
		if !hasAfter {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid query"})
			return
		}
		limit := parseLimitQuery(req, "limit", 200, 200)
		messages := deps.Store.ListMessages(session.ID, 0, limit)
		response := make([]map[string]any, 0, len(messages))
		for _, msg := range messages {
			if msg.Seq <= afterSeq {
				continue
			}
			entry := map[string]any{
				"id":        msg.ID,
				"content":   msg.Content,
				"createdAt": msg.CreatedAt,
				"seq":       msg.Seq,
			}
			if msg.LocalID != "" {
				entry["localId"] = msg.LocalID
			}
			response = append(response, entry)
		}
		writeJSON(w, http.StatusOK, map[string]any{"messages": response})
	}, cors, cliMiddleware))

	router.Handle(http.MethodPost, "/cli/machines", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		body, err := decodeJSON(req)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		id, ok := body["id"].(string)
		if !ok || id == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid body"})
			return
		}
		namespace := namespaceFromRequest(req)
		if deps.Store.MachineExists(id) {
			existing, _ := deps.Store.GetMachine(namespace, id)
			if existing == nil {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "Machine access denied"})
				return
			}
		}
		metadata := body["metadata"]
		runnerState := body["runnerState"]
		machine, err := deps.Store.UpsertMachine(namespace, id, metadata, runnerState)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to upsert machine"})
			return
		}
		if deps.Engine != nil {
			deps.Engine.HandleRealtimeEvent(syncengine.SyncEvent{
				Type:      "machine-updated",
				Namespace: namespace,
				MachineID: machine.ID,
				Data:      syncengine.MachineEventData(machine),
			})
		} else {
			deps.SSEBus.Publish(sse.Event{
				Type: "machine-updated",
				Data: map[string]any{
					"namespace": namespace,
					"machineId": machine.ID,
					"data":      machineToPayload(machine),
				},
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"machine": machineToPayload(machine)})
	}, cors, cliMiddleware))

	router.Handle(http.MethodGet, "/cli/machines/:id", withMiddleware(func(w http.ResponseWriter, req *http.Request, params Params) {
		namespace := namespaceFromRequest(req)
		machine, ok := requireMachine(w, deps.Store, deps.Engine, namespace, params["id"])
		if !ok {
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"machine": machineToPayload(machine)})
	}, cors, cliMiddleware))
}

func decodeJSON(req *http.Request) (map[string]any, error) {
	decoder := json.NewDecoder(req.Body)
	decoder.UseNumber()
	var payload map[string]any
	if err := decoder.Decode(&payload); err != nil {
		return nil, err
	}
	if decoder.More() {
		return nil, errors.New("invalid JSON payload")
	}
	if payload == nil {
		return nil, errors.New("empty payload")
	}
	return payload, nil
}

func decodeJSONOptional(req *http.Request) (map[string]any, error) {
	decoder := json.NewDecoder(req.Body)
	decoder.UseNumber()
	var payload map[string]any
	if err := decoder.Decode(&payload); err != nil {
		if errors.Is(err, io.EOF) {
			return map[string]any{}, nil
		}
		return nil, err
	}
	if decoder.More() {
		return nil, errors.New("invalid JSON payload")
	}
	if payload == nil {
		return map[string]any{}, nil
	}
	return payload, nil
}

func signJWT(secret []byte, userID int64, namespace string) (string, error) {
	claims := jwt.MapClaims{
		"uid": userID,
		"ns":  namespace,
		"iat": time.Now().Unix(),
		"exp": time.Now().Add(15 * time.Minute).Unix(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(secret)
}

func namespaceFromRequest(req *http.Request) string {
	if req == nil {
		return "default"
	}
	if ns, ok := NamespaceFromContext(req.Context()); ok && ns != "" {
		return ns
	}
	return "default"
}

func parseOptionalIntQueryMin(req *http.Request, key string, min int64) (int64, bool) {
	if req == nil {
		return 0, false
	}
	raw := req.URL.Query().Get(key)
	if raw == "" {
		return 0, false
	}
	parsed, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, false
	}
	if parsed < min {
		return 0, false
	}
	return parsed, true
}

func parseBoolQuery(req *http.Request, key string) *bool {
	if req == nil {
		return nil
	}
	raw := req.URL.Query().Get(key)
	if raw == "" {
		return nil
	}
	if raw == "true" {
		value := true
		return &value
	}
	if raw == "false" {
		value := false
		return &value
	}
	return nil
}

func parseBool(raw string) bool {
	if raw == "" {
		return false
	}
	return raw == "true" || raw == "1"
}

func parseLimitQuery(req *http.Request, key string, fallback int, max int) int {
	if req == nil {
		return fallback
	}
	raw := req.URL.Query().Get(key)
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	if parsed < 1 {
		return fallback
	}
	if max > 0 && parsed > max {
		return max
	}
	return parsed
}

func requireSession(w http.ResponseWriter, storeInstance *store.Store, engine *syncengine.Engine, namespace string, id string) (*store.Session, bool) {
	var session *store.Session
	var err error
	if engine != nil {
		session = engine.GetSessionByNamespace(id, namespace)
	} else {
		session, err = storeInstance.GetSession(namespace, id)
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to load session"})
		return nil, false
	}
	if session != nil {
		return session, true
	}
	if storeInstance.SessionExists(id) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Session access denied"})
		return nil, false
	}
	writeJSON(w, http.StatusNotFound, map[string]string{"error": "Session not found"})
	return nil, false
}

func requireMachine(w http.ResponseWriter, storeInstance *store.Store, engine *syncengine.Engine, namespace string, id string) (*store.Machine, bool) {
	var machine *store.Machine
	var err error
	if engine != nil {
		machine = engine.GetMachine(id, namespace)
	} else {
		machine, err = storeInstance.GetMachine(namespace, id)
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to load machine"})
		return nil, false
	}
	if machine != nil {
		return machine, true
	}
	if storeInstance.MachineExists(id) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Machine access denied"})
		return nil, false
	}
	writeJSON(w, http.StatusNotFound, map[string]string{"error": "Machine not found"})
	return nil, false
}

func sessionToPayload(session *store.Session) map[string]any {
	if session == nil {
		return map[string]any{}
	}
	return map[string]any{
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
		"permissionMode":    nullableStringToValue(session.PermissionMode),
		"modelMode":         nullableStringToValue(session.ModelMode),
	}
}

func machineToPayload(machine *store.Machine) map[string]any {
	if machine == nil {
		return map[string]any{}
	}
	return map[string]any{
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
	}
}

func estimateBase64Bytes(base64 string) int {
	if base64 == "" {
		return 0
	}
	padding := 0
	if strings.HasSuffix(base64, "==") {
		padding = 2
	} else if strings.HasSuffix(base64, "=") {
		padding = 1
	}
	return (len(base64)*3)/4 - padding
}

func getMetadataString(metadata any, key string, fallback string) string {
	m, ok := metadata.(map[string]any)
	if !ok {
		return fallback
	}
	if value, ok := m[key].(string); ok && value != "" {
		return value
	}
	return fallback
}

func toStringSlice(value any) []string {
	raw, ok := value.([]any)
	if !ok {
		return nil
	}
	result := make([]string, 0, len(raw))
	for _, item := range raw {
		if s, ok := item.(string); ok {
			result = append(result, s)
		}
	}
	return result
}

func uniqueStrings(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func hasPendingRequest(session *store.Session, requestID string) bool {
	if session == nil || requestID == "" {
		return false
	}
	state, ok := session.AgentState.(map[string]any)
	if !ok {
		return false
	}
	requests, ok := state["requests"].(map[string]any)
	if !ok {
		return false
	}
	_, ok = requests[requestID]
	return ok
}

func emptyToNil(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func allowToolsOrNil(values []string) any {
	if len(values) == 0 {
		return nil
	}
	return values
}

func rpcCallJSON(socket *socketio.Server, id string, method string, params map[string]any) (any, error) {
	if socket == nil {
		return nil, errors.New("not connected")
	}
	if id == "" {
		return nil, errors.New("missing id")
	}
	if params == nil {
		params = map[string]any{}
	}
	methodName := id + ":" + method
	paramsRaw, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	_, ch, err := socket.SendRpc(methodName, map[string]any{
		"method": methodName,
		"params": string(paramsRaw),
	})
	if err != nil || ch == nil {
		return nil, err
	}
	select {
	case raw := <-ch:
		return decodeRPCPayload(raw)
	case <-time.After(30 * time.Second):
		return nil, errors.New("rpc timeout")
	}
}

func rpcCallUnified(engine *syncengine.Engine, socket *socketio.Server, id string, method string, params map[string]any) (any, error) {
	if engine != nil && engine.RpcGateway() != nil {
		return rpcCallEngineJSON(engine, id, method, params)
	}
	return rpcCallJSON(socket, id, method, params)
}

func rpcCallEngineJSON(engine *syncengine.Engine, id string, method string, params map[string]any) (any, error) {
	if engine == nil || engine.RpcGateway() == nil {
		return nil, errors.New("not connected")
	}
	if id == "" {
		return nil, errors.New("missing id")
	}
	if params == nil {
		params = map[string]any{}
	}
	methodName := id + ":" + method
	paramsRaw, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	raw, err := engine.RpcGateway().Call(methodName, map[string]any{
		"method": methodName,
		"params": string(paramsRaw),
	}, 30*time.Second)
	if err != nil {
		return nil, err
	}
	return decodeRPCPayload(raw)
}

func decodeRPCPayload(raw json.RawMessage) (any, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, errors.New("empty response")
	}
	var str string
	if err := json.Unmarshal(raw, &str); err == nil {
		if str == "" {
			return str, nil
		}
		var decoded any
		if err := json.Unmarshal([]byte(str), &decoded); err == nil {
			return decoded, nil
		}
		return str, nil
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err == nil {
		return decoded, nil
	}
	return nil, errors.New("invalid response")
}

func mapRipgrepFiles(result any, limit int) map[string]any {
	response, ok := result.(map[string]any)
	if !ok {
		return map[string]any{"success": false, "error": "Unexpected response"}
	}
	success, _ := response["success"].(bool)
	if !success {
		return response
	}
	stdout, _ := response["stdout"].(string)
	if stdout == "" {
		return map[string]any{"success": true, "files": []any{}}
	}
	lines := strings.Split(stdout, "\n")
	files := make([]map[string]any, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Split(line, "/")
		fileName := line
		filePath := ""
		if len(parts) > 1 {
			fileName = parts[len(parts)-1]
			filePath = strings.Join(parts[:len(parts)-1], "/")
		}
		files = append(files, map[string]any{
			"fileName": fileName,
			"filePath": filePath,
			"fullPath": line,
			"fileType": "file",
		})
		if limit > 0 && len(files) >= limit {
			break
		}
	}
	return map[string]any{"success": true, "files": files}
}

func normalizeSpawnResponse(result any) map[string]any {
	obj, ok := result.(map[string]any)
	if !ok {
		return map[string]any{"type": "error", "message": "Unexpected spawn result"}
	}
	if typ, _ := obj["type"].(string); typ == "success" {
		if sessionID, _ := obj["sessionId"].(string); sessionID != "" {
			return map[string]any{"type": "success", "sessionId": sessionID}
		}
	}
	if typ, _ := obj["type"].(string); typ == "error" {
		if message, _ := obj["errorMessage"].(string); message != "" {
			return map[string]any{"type": "error", "message": message}
		}
	}
	return map[string]any{"type": "error", "message": "Unexpected spawn result"}
}

func normalizePathExists(result any) map[string]any {
	obj, ok := result.(map[string]any)
	if !ok {
		return map[string]any{"exists": map[string]bool{}}
	}
	existsRaw, _ := obj["exists"].(map[string]any)
	if existsRaw == nil {
		return map[string]any{"exists": map[string]bool{}}
	}
	exists := map[string]bool{}
	for key, value := range existsRaw {
		exists[key] = value == true
	}
	return map[string]any{"exists": exists}
}

func messageToEvent(message store.Message) map[string]any {
	result := map[string]any{
		"id":        message.ID,
		"seq":       message.Seq,
		"content":   message.Content,
		"createdAt": message.CreatedAt,
	}
	if message.LocalID != "" {
		result["localId"] = message.LocalID
	} else {
		result["localId"] = nil
	}
	return result
}

func attachmentsEmpty(value any) bool {
	if value == nil {
		return true
	}
	switch v := value.(type) {
	case []any:
		return len(v) == 0
	default:
		return false
	}
}

func nullableStringToValue(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func newUpdateID() string {
	return strconv.FormatInt(time.Now().UnixNano(), 10)
}

func countPendingRequests(agentState any) int {
	state, ok := agentState.(map[string]any)
	if !ok {
		return 0
	}
	requests, ok := state["requests"].(map[string]any)
	if !ok {
		return 0
	}
	return len(requests)
}

func computeTodoProgress(todos any) any {
	items, ok := todos.([]any)
	if !ok || len(items) == 0 {
		return nil
	}
	completed := 0
	total := 0
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		status, _ := entry["status"].(string)
		if status == "" {
			continue
		}
		total++
		if status == "completed" {
			completed++
		}
	}
	if total == 0 {
		return nil
	}
	return map[string]any{
		"completed": completed,
		"total":     total,
	}
}

func selectResumeMachine(machines []store.Machine, metadata any) *store.Machine {
	if len(machines) == 0 {
		return nil
	}
	online := make([]store.Machine, 0, len(machines))
	for _, machine := range machines {
		if machine.Active {
			online = append(online, machine)
		}
	}
	if len(online) == 0 {
		return nil
	}
	meta, _ := metadata.(map[string]any)
	if meta != nil {
		if machineID, _ := meta["machineId"].(string); machineID != "" {
			for _, machine := range online {
				if machine.ID == machineID {
					return &machine
				}
			}
		}
		if host, _ := meta["host"].(string); host != "" {
			for _, machine := range online {
				if m := machine.Metadata; m != nil {
					if mm, ok := m.(map[string]any); ok {
						if mh, _ := mm["host"].(string); mh == host {
							return &machine
						}
					}
				}
			}
		}
	}
	return &online[0]
}

func waitForSessionActive(store *store.Store, namespace string, sessionID string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		session, err := store.GetSession(namespace, sessionID)
		if err == nil && session != nil && session.Active {
			return true
		}
		time.Sleep(250 * time.Millisecond)
	}
	return false
}
