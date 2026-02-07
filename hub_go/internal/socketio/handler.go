package socketio

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"hub_go/internal/auth"
)

type OpenPayload struct {
	SID          string   `json:"sid"`
	Upgrades     []string `json:"upgrades"`
	PingInterval int      `json:"pingInterval"`
	PingTimeout  int      `json:"pingTimeout"`
}

type Session struct {
	SID        string
	CreatedAt  time.Time
	SessionID  string
	MachineID  string
	HapiNS     string
	Namespaces map[string]struct{}
	LastSeen   time.Time
	LastPong   time.Time
}

type Server struct {
	sessions map[string]*Session
	deps     Dependencies
	outbox   *Outbox
	terminal *TerminalRegistry
	mu       sync.RWMutex
	wsConns  map[string]map[*wsConn]struct{}
	ackMu    sync.Mutex
	ackSeq   uint64
	acks     map[string]chan json.RawMessage
	rpcMu    sync.RWMutex
	rpcMap   map[string]*wsConn
}

const (
	enginePingIntervalMs = 25000
	enginePingTimeoutMs  = 20000
	engineIdleTimeoutMs  = 70000
)

func NewServer(deps Dependencies) *Server {
	return &Server{
		sessions: make(map[string]*Session),
		deps:     deps,
		outbox:   NewOutbox(),
		terminal: NewTerminalRegistry(4, 4, 15*time.Minute, nil),
		wsConns:  make(map[string]map[*wsConn]struct{}),
		acks:     make(map[string]chan json.RawMessage),
		rpcMap:   make(map[string]*wsConn),
	}
}

func (s *Server) isExpired(sess *Session) bool {
	if sess == nil {
		return true
	}
	if sess.LastSeen.IsZero() {
		return false
	}
	return time.Since(sess.LastSeen) > time.Duration(engineIdleTimeoutMs)*time.Millisecond
}

func (s *Server) touchSession(sid string) {
	if sid == "" {
		return
	}
	if sess, ok := s.sessions[sid]; ok {
		sess.LastSeen = time.Now()
	}
}

func (s *Server) markPong(sid string) {
	if sid == "" {
		return
	}
	if sess, ok := s.sessions[sid]; ok {
		now := time.Now()
		sess.LastSeen = now
		sess.LastPong = now
	}
}

func (s *Server) Handle(w http.ResponseWriter, req *http.Request) {
	transport := req.URL.Query().Get("transport")
	eio := req.URL.Query().Get("EIO")

	if transport == "polling" && (eio == "4" || eio == "") {
		if req.URL.Query().Get("t") == "" {
			w.Header().Set("Cache-Control", "no-store")
		}
		sid := req.URL.Query().Get("sid")
		if req.Method == http.MethodPost {
			body, _ := readBody(req)
			response := s.handlePollingPayload(sid, body)
			w.Header().Set("Content-Type", "text/plain; charset=UTF-8")
			w.WriteHeader(http.StatusOK)
			if response == "" {
				_, _ = w.Write([]byte("ok"))
			} else {
				_, _ = w.Write([]byte(response))
			}
			return
		}
		if sid != "" && req.Method == http.MethodGet {
			targetSession := ""
			targetMachine := ""
			targetNamespace := ""
			var namespaces []string
			if sess, ok := s.sessions[sid]; ok {
				if s.isExpired(sess) {
					delete(s.sessions, sid)
					w.Header().Set("Content-Type", "text/plain; charset=UTF-8")
					w.WriteHeader(http.StatusBadRequest)
					_, _ = w.Write([]byte("session expired"))
					return
				}
				targetSession = sess.SessionID
				targetMachine = sess.MachineID
				targetNamespace = sess.HapiNS
				if len(sess.Namespaces) > 0 {
					for ns := range sess.Namespaces {
						namespaces = append(namespaces, ns)
					}
				}
				s.touchSession(sid)
			}
			if len(namespaces) == 0 {
				w.Header().Set("Content-Type", "text/plain; charset=UTF-8")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte("6"))
				return
			}
			var queued []string
			for _, namespace := range namespaces {
				if namespace == "/terminal" {
					queued = append(queued, s.outbox.Dequeue(namespace, targetSession, "", sid)...)
					continue
				}
				sessionFilter := targetSession
				machineFilter := targetMachine
				if namespace == "/cli" && targetNamespace != "" {
					sessionFilter = ""
					machineFilter = ""
				}
				queued = append(queued, s.outbox.Dequeue(namespace, sessionFilter, machineFilter, "")...)
			}
			if len(queued) > 0 {
				payload := ""
				for _, packet := range queued {
					payload += string(EngineMessage) + packet
				}
				w.Header().Set("Content-Type", "text/plain; charset=UTF-8")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(payload))
				return
			}
			w.Header().Set("Content-Type", "text/plain; charset=UTF-8")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("6"))
			return
		}
		payload := OpenPayload{
			SID:          s.newSID(),
			Upgrades:     []string{"websocket"},
			PingInterval: enginePingIntervalMs,
			PingTimeout:  enginePingTimeoutMs,
		}
		raw, err := json.Marshal(payload)
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=UTF-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(append([]byte("0"), raw...))
		return
	}

	if transport == "websocket" && (eio == "4" || eio == "") {
		s.handleWebsocket(w, req)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusNotImplemented)
	_, _ = w.Write([]byte(`{"error":"not_implemented"}`))
}

func (s *Server) handlePollingPayload(sid string, payload string) string {
	if payload == "" {
		return ""
	}
	parts := parseEnginePayload(payload)
	for _, part := range parts {
		if part == "" {
			continue
		}
		switch part[0] {
		case byte(EnginePing):
			if part == "2probe" {
				s.markPong(sid)
				return "3probe"
			}
			s.markPong(sid)
			return string(EnginePong)
		case byte(EnginePong):
			s.markPong(sid)
			return ""
		case byte(EngineMessage):
			msg := parseSocketMessage(part[1:])
			if msg == nil {
				continue
			}
			if msg.Type == SocketConnect {
				sessionID, machineID, hapiNamespace, err := s.validateConnect(msg.Namespace, msg.Data)
				if err != nil {
					return string(EngineMessage) + encodeSocketError(msg.Namespace, err.Error())
				}
				if sid != "" {
					s.trackSessionTargets(sid, sessionID, machineID)
					s.trackNamespace(sid, msg.Namespace)
					if sess, ok := s.sessions[sid]; ok {
						sess.HapiNS = hapiNamespace
					}
					s.touchSession(sid)
				}
				return string(EngineMessage) + encodeSocketConnect(msg.Namespace)
			}
			if msg.Type == SocketEvent {
				s.touchSession(sid)
				ackID, trimmed := parseSocketAckID(msg.Data)
				if eventName, eventPayload, ok := parseSocketEventPayload(trimmed); ok {
					ackPayload, hasAck := s.handleEventWithEngine(sid, nil, msg.Namespace, eventName, eventPayload)
					if ackID != "" {
						if hasAck {
							return string(EngineMessage) + encodeSocketAckWithIDPayload(msg.Namespace, ackID, ackPayload)
						}
						return string(EngineMessage) + encodeSocketAckWithID(msg.Namespace, ackID)
					}
				}
				return string(EngineMessage) + encodeSocketAck(msg.Namespace)
			}
			if msg.Type == SocketAck {
				s.touchSession(sid)
				ackID, trimmed := parseSocketAckID(msg.Data)
				if ackID != "" {
					s.resolveAck(ackID, trimmed)
				}
				return ""
			}
			if msg.Type == SocketError {
				s.touchSession(sid)
				return string(EngineMessage) + encodeSocketError(msg.Namespace, "error")
			}
			if msg.Type == SocketDisconnect {
				if sid != "" {
					if msg.Namespace == "/terminal" && s.terminal != nil {
						removed := s.terminal.RemoveBySocket(sid)
						for _, entry := range removed {
							s.sendToWsConn(entry.CliConn, "/cli", "terminal:close", map[string]any{
								"sessionId":  entry.SessionID,
								"terminalId": entry.TerminalID,
							})
						}
					}
					s.untrackNamespace(sid, msg.Namespace)
				}
				s.touchSession(sid)
				return ""
			}
		case byte(EngineUpgrade):
			s.touchSession(sid)
			return ""
		default:
			continue
		}
	}
	return ""
}

func (s *Server) Send(namespace string, event string, payload any) {
	if s == nil {
		return
	}
	packet := encodeSocketEvent(namespace, event, payload)
	s.outbox.Enqueue(namespace, packet, "", "", "")
	s.broadcastWS(namespace, string(EngineMessage)+packet, "", "")
}

func (s *Server) SendToConn(namespace string, event string, payload any, engineID string) {
	if s == nil || engineID == "" {
		return
	}
	packet := encodeSocketEvent(namespace, event, payload)
	s.outbox.Enqueue(namespace, packet, "", "", engineID)
	s.broadcastWS(namespace, string(EngineMessage)+packet, "", "")
}

func (s *Server) SendWithAck(namespace string, event string, payload any) (string, <-chan json.RawMessage) {
	if s == nil {
		return "", nil
	}
	ackID := s.nextAckID()
	packet := encodeSocketEventWithID(namespace, ackID, event, payload)
	ch := s.registerAck(ackID)
	s.outbox.Enqueue(namespace, packet, "", "", "")
	s.broadcastWS(namespace, string(EngineMessage)+packet, "", "")
	return ackID, ch
}

func (s *Server) SendToSession(namespace string, event string, payload any, sessionID string) {
	if s == nil || sessionID == "" {
		return
	}
	packet := encodeSocketEvent(namespace, event, payload)
	s.outbox.Enqueue(namespace, packet, sessionID, "", "")
	s.broadcastWS(namespace, string(EngineMessage)+packet, sessionID, "")
}

func (s *Server) SendToMachine(namespace string, event string, payload any, machineID string) {
	if s == nil || machineID == "" {
		return
	}
	packet := encodeSocketEvent(namespace, event, payload)
	s.outbox.Enqueue(namespace, packet, "", machineID, "")
	s.broadcastWS(namespace, string(EngineMessage)+packet, "", machineID)
}

func (s *Server) SendRpc(method string, payload any) (string, <-chan json.RawMessage, error) {
	if s == nil {
		return "", nil, errors.New("not connected")
	}
	conn := s.getRpcConn(method)
	if conn == nil {
		return "", nil, errors.New("rpc handler not registered")
	}
	ackID := s.nextAckID()
	packet := encodeSocketEventWithID("/cli", ackID, "rpc-request", payload)
	ch := s.registerAck(ackID)
	if err := conn.writeText(string(EngineMessage) + packet); err != nil {
		return "", nil, err
	}
	return ackID, ch, nil
}

func (s *Server) validateConnect(namespace string, raw string) (string, string, string, error) {
	if namespace == "" {
		namespace = "/"
	}
	authToken, sessionID, machineID := extractAuthTokenAndTargets(raw)
	switch namespace {
	case "/cli":
		parsed := auth.ParseAccessToken(authToken)
		if parsed == nil || !auth.ConstantTimeEquals(parsed.BaseToken, s.deps.CliApiToken) {
			return "", "", "", errors.New("invalid token")
		}
		return sessionID, machineID, parsed.Namespace, nil
	case "/terminal":
		if authToken == "" {
			return "", "", "", errors.New("missing token")
		}
		claims := struct {
			UID float64 `json:"uid"`
			NS  string  `json:"ns"`
			jwt.RegisteredClaims
		}{}
		parsed, err := jwt.ParseWithClaims(authToken, &claims, func(token *jwt.Token) (any, error) {
			if token.Method != jwt.SigningMethodHS256 {
				return nil, errors.New("invalid token")
			}
			return s.deps.JWTSecret, nil
		})
		if err != nil || !parsed.Valid {
			return "", "", "", errors.New("invalid token")
		}
		if claims.NS == "" {
			return "", "", "", errors.New("invalid token")
		}
		return sessionID, machineID, claims.NS, nil
	default:
		return sessionID, machineID, "", nil
	}
}

func extractAuthTokenAndTargets(raw string) (string, string, string) {
	if raw == "" {
		return "", "", ""
	}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", "", ""
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
		return "", "", ""
	}
	auth, ok := payload["token"].(string)
	if !ok {
		auth = ""
	}
	sessionID, _ := payload["sessionId"].(string)
	machineID, _ := payload["machineId"].(string)
	return auth, sessionID, machineID
}

func readBody(req *http.Request) (string, error) {
	if req == nil || req.Body == nil {
		return "", nil
	}
	defer req.Body.Close()
	raw, err := io.ReadAll(req.Body)
	if err != nil {
		return "", err
	}
	if len(raw) == 0 {
		return "", nil
	}
	return string(raw), nil
}

func (s *Server) newSID() string {
	sid := newSID()
	now := time.Now()
	s.sessions[sid] = &Session{
		SID:        sid,
		CreatedAt:  now,
		Namespaces: map[string]struct{}{},
		LastSeen:   now,
		LastPong:   now,
	}
	return sid
}

func (s *Server) nextAckID() string {
	s.ackMu.Lock()
	s.ackSeq++
	id := s.ackSeq
	s.ackMu.Unlock()
	return strconv.FormatUint(id, 10)
}

func (s *Server) trackSessionTargets(sid string, sessionID string, machineID string) {
	if sid == "" {
		return
	}
	if sess, ok := s.sessions[sid]; ok {
		if sessionID != "" {
			sess.SessionID = sessionID
		}
		if machineID != "" {
			sess.MachineID = machineID
		}
		sess.LastSeen = time.Now()
		return
	}
	now := time.Now()
	s.sessions[sid] = &Session{
		SID:        sid,
		CreatedAt:  now,
		SessionID:  sessionID,
		MachineID:  machineID,
		Namespaces: map[string]struct{}{},
		LastSeen:   now,
		LastPong:   now,
	}
}

func (s *Server) trackNamespace(sid string, namespace string) {
	if sid == "" || namespace == "" {
		return
	}
	if sess, ok := s.sessions[sid]; ok {
		if sess.Namespaces == nil {
			sess.Namespaces = map[string]struct{}{}
		}
		sess.Namespaces[namespace] = struct{}{}
		sess.LastSeen = time.Now()
		return
	}
	now := time.Now()
	s.sessions[sid] = &Session{
		SID:        sid,
		CreatedAt:  now,
		Namespaces: map[string]struct{}{namespace: {}},
		LastSeen:   now,
		LastPong:   now,
	}
}

func (s *Server) untrackNamespace(sid string, namespace string) {
	if sid == "" || namespace == "" {
		return
	}
	if sess, ok := s.sessions[sid]; ok && sess.Namespaces != nil {
		delete(sess.Namespaces, namespace)
	}
}

func (s *Server) registerAck(id string) chan json.RawMessage {
	ch := make(chan json.RawMessage, 1)
	s.ackMu.Lock()
	s.acks[id] = ch
	s.ackMu.Unlock()
	return ch
}

func (s *Server) resolveAck(id string, raw string) {
	payload := parseAckPayload(raw)
	s.ackMu.Lock()
	ch := s.acks[id]
	delete(s.acks, id)
	s.ackMu.Unlock()
	if ch != nil {
		ch <- payload
		close(ch)
	}
}

func (s *Server) registerRpcMethod(method string, conn *wsConn) {
	if method == "" || conn == nil {
		return
	}
	s.rpcMu.Lock()
	s.rpcMap[method] = conn
	s.rpcMu.Unlock()
}

func (s *Server) unregisterRpcMethod(method string, conn *wsConn) {
	if method == "" || conn == nil {
		return
	}
	s.rpcMu.Lock()
	if existing, ok := s.rpcMap[method]; ok && existing == conn {
		delete(s.rpcMap, method)
	}
	s.rpcMu.Unlock()
}

func (s *Server) unregisterRpcConn(conn *wsConn) {
	if conn == nil {
		return
	}
	s.rpcMu.Lock()
	for method, existing := range s.rpcMap {
		if existing == conn {
			delete(s.rpcMap, method)
		}
	}
	s.rpcMu.Unlock()
}

func (s *Server) getRpcConn(method string) *wsConn {
	if method == "" {
		return nil
	}
	s.rpcMu.RLock()
	conn := s.rpcMap[method]
	s.rpcMu.RUnlock()
	return conn
}
