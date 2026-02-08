package socketio

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestServer() *Server {
	srv := &Server{
		sessions: make(map[string]*Session),
		outbox:   NewOutbox(),
		wsConns:  make(map[string]map[*wsConn]struct{}),
		acks:     make(map[string]chan json.RawMessage),
		rpcMap:   make(map[string]*wsConn),
		stopCh:   make(chan struct{}),
	}
	return srv
}

// --- Polling Handshake ---

func TestHandle_PollingHandshake(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	req := httptest.NewRequest("GET", "/socket.io/?transport=polling&EIO=4", nil)
	w := httptest.NewRecorder()

	srv.Handle(w, req)

	resp := w.Result()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	bodyStr := string(body)
	// Should start with "0" (Engine.IO OPEN packet)
	if !strings.HasPrefix(bodyStr, "0") {
		t.Fatalf("response should start with '0', got %q", bodyStr)
	}

	// Parse the open payload
	var open OpenPayload
	if err := json.Unmarshal(body[1:], &open); err != nil {
		t.Fatalf("failed to parse open payload: %v", err)
	}

	if open.SID == "" {
		t.Fatal("SID should not be empty")
	}
	if open.PingInterval != enginePingIntervalMs {
		t.Fatalf("PingInterval = %d, want %d", open.PingInterval, enginePingIntervalMs)
	}
	if open.PingTimeout != enginePingTimeoutMs {
		t.Fatalf("PingTimeout = %d, want %d", open.PingTimeout, enginePingTimeoutMs)
	}
	if len(open.Upgrades) == 0 || open.Upgrades[0] != "websocket" {
		t.Fatalf("Upgrades = %v, want [websocket]", open.Upgrades)
	}

	// Verify session was created
	if len(srv.sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(srv.sessions))
	}
}

// --- Polling GET (no queued messages) ---

func TestHandle_PollingGet_NoMessages(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	// Create a session first
	sid := srv.newSID()
	srv.sessMu.Lock()
	srv.sessions[sid].Namespaces["/cli"] = struct{}{}
	srv.sessMu.Unlock()

	req := httptest.NewRequest("GET", "/socket.io/?transport=polling&EIO=4&sid="+sid, nil)
	w := httptest.NewRecorder()

	srv.Handle(w, req)
	resp := w.Result()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	// Should return NOOP packet "6"
	if string(body) != "6" {
		t.Fatalf("got %q, want NOOP '6'", string(body))
	}
}

// --- Polling GET with queued messages ---

func TestHandle_PollingGet_WithMessages(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	sid := srv.newSID()
	srv.sessMu.Lock()
	srv.sessions[sid].Namespaces["/cli"] = struct{}{}
	srv.sessions[sid].SessionID = "s1"
	srv.sessMu.Unlock()

	// Enqueue a message
	srv.outbox.Enqueue("/cli", `2["update",{"test":true}]`, "s1", "", "")

	req := httptest.NewRequest("GET", "/socket.io/?transport=polling&EIO=4&sid="+sid, nil)
	w := httptest.NewRecorder()

	srv.Handle(w, req)
	resp := w.Result()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	bodyStr := string(body)
	if !strings.Contains(bodyStr, "update") {
		t.Fatalf("response should contain queued message: %q", bodyStr)
	}
}

// --- Polling POST ---

func TestHandle_PollingPost_EmptyBody(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	sid := srv.newSID()
	req := httptest.NewRequest("POST", "/socket.io/?transport=polling&EIO=4&sid="+sid, strings.NewReader(""))
	w := httptest.NewRecorder()

	srv.Handle(w, req)
	resp := w.Result()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if string(body) != "ok" {
		t.Fatalf("got %q, want 'ok'", string(body))
	}
}

// --- Polling POST with ping ---

func TestHandle_PollingPost_Ping(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	sid := srv.newSID()
	// Send Engine.IO PING packet "2"
	req := httptest.NewRequest("POST", "/socket.io/?transport=polling&EIO=4&sid="+sid, strings.NewReader("2"))
	w := httptest.NewRecorder()

	srv.Handle(w, req)
	resp := w.Result()

	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
}

// --- Unknown transport ---

func TestHandle_UnknownTransport(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	req := httptest.NewRequest("GET", "/socket.io/?transport=unknown", nil)
	w := httptest.NewRecorder()

	srv.Handle(w, req)
	resp := w.Result()

	if resp.StatusCode != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501", resp.StatusCode)
	}
}

// --- Expired session GET ---

func TestHandle_PollingGet_ExpiredSession(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	sid := srv.newSID()
	srv.sessMu.Lock()
	// Make the session expired
	srv.sessions[sid].LastSeen = srv.sessions[sid].CreatedAt.Add(-2 * engineIdleTimeoutMs * 1e6)
	srv.sessions[sid].Namespaces["/cli"] = struct{}{}
	srv.sessMu.Unlock()

	req := httptest.NewRequest("GET", "/socket.io/?transport=polling&EIO=4&sid="+sid, nil)
	w := httptest.NewRecorder()

	srv.Handle(w, req)
	resp := w.Result()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400. body=%q", resp.StatusCode, string(body))
	}
}

// --- Polling GET no namespace ---

func TestHandle_PollingGet_NoNamespace(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	sid := srv.newSID()
	// No namespaces tracked

	req := httptest.NewRequest("GET", "/socket.io/?transport=polling&EIO=4&sid="+sid, nil)
	w := httptest.NewRecorder()

	srv.Handle(w, req)
	resp := w.Result()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if string(body) != "6" {
		t.Fatalf("got %q, want '6' (NOOP)", string(body))
	}
}

// --- Send / SendToSession / SendToMachine ---

func TestServer_Send(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	srv.Send("/cli", "update", map[string]string{"test": "true"})

	got := srv.outbox.Dequeue("/cli", "", "", "")
	if len(got) != 1 {
		t.Fatalf("expected 1 queued message, got %d", len(got))
	}
	if !strings.Contains(got[0], "update") {
		t.Fatalf("message should contain 'update': %q", got[0])
	}
}

func TestServer_SendToSession(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	srv.SendToSession("/cli", "update", "data", "session-1")

	// Should be filtered by session ID
	got := srv.outbox.Dequeue("/cli", "session-1", "", "")
	if len(got) != 1 {
		t.Fatalf("expected 1 message for session-1, got %d", len(got))
	}

	// Different session should get nothing
	got = srv.outbox.Dequeue("/cli", "session-2", "", "")
	if len(got) != 0 {
		t.Fatalf("expected 0 messages for session-2, got %d", len(got))
	}
}

func TestServer_SendToMachine(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	srv.SendToMachine("/cli", "update", "data", "machine-1")

	got := srv.outbox.Dequeue("/cli", "", "machine-1", "")
	if len(got) != 1 {
		t.Fatalf("expected 1 message for machine-1, got %d", len(got))
	}
}

// --- SendWithAck ---

func TestServer_SendWithAck(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	ackID, ch := srv.SendWithAck("/cli", "request", map[string]string{"q": "test"})
	if ackID == "" {
		t.Fatal("ackID should not be empty")
	}
	if ch == nil {
		t.Fatal("channel should not be nil")
	}

	// Resolve the ack
	srv.resolveAck(ackID, `["response"]`)
	select {
	case result := <-ch:
		if string(result) != `"response"` {
			t.Fatalf("ack result = %s, want \"response\"", result)
		}
	default:
		t.Fatal("channel should have a value")
	}
}

// --- Track/Untrack Namespace ---

func TestServer_TrackUntrackNamespace(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	sid := srv.newSID()
	srv.trackNamespace(sid, "/cli")

	srv.sessMu.RLock()
	sess := srv.sessions[sid]
	_, hasNS := sess.Namespaces["/cli"]
	srv.sessMu.RUnlock()

	if !hasNS {
		t.Fatal("namespace /cli should be tracked")
	}

	srv.untrackNamespace(sid, "/cli")
	srv.sessMu.RLock()
	_, hasNS = sess.Namespaces["/cli"]
	srv.sessMu.RUnlock()
	if hasNS {
		t.Fatal("namespace /cli should be untracked")
	}
}

// --- readBody ---

func TestReadBody_NilRequest(t *testing.T) {
	got, err := readBody(nil)
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if got != "" {
		t.Fatalf("got %q, want empty", got)
	}
}

func TestReadBody_EmptyBody(t *testing.T) {
	req := httptest.NewRequest("POST", "/", strings.NewReader(""))
	got, err := readBody(req)
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if got != "" {
		t.Fatalf("got %q, want empty", got)
	}
}

func TestReadBody_WithContent(t *testing.T) {
	req := httptest.NewRequest("POST", "/", strings.NewReader("hello world"))
	got, err := readBody(req)
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if got != "hello world" {
		t.Fatalf("got %q, want 'hello world'", got)
	}
}

// --- handlePollingPayload ---

func TestHandlePollingPayload_Empty(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	got := srv.handlePollingPayload("sid", "")
	if got != "" {
		t.Fatalf("got %q, want empty", got)
	}
}

func TestHandlePollingPayload_Ping(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	sid := srv.newSID()
	got := srv.handlePollingPayload(sid, "2")
	if got != "3" {
		t.Fatalf("ping response = %q, want '3' (pong)", got)
	}
}

func TestHandlePollingPayload_Probe(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	sid := srv.newSID()
	got := srv.handlePollingPayload(sid, "2probe")
	if got != "3probe" {
		t.Fatalf("probe response = %q, want '3probe'", got)
	}
}

func TestHandlePollingPayload_Pong(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	sid := srv.newSID()
	got := srv.handlePollingPayload(sid, "3")
	if got != "" {
		t.Fatalf("pong response = %q, want empty", got)
	}
}

func TestHandlePollingPayload_Upgrade(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	sid := srv.newSID()
	got := srv.handlePollingPayload(sid, "5")
	if got != "" {
		t.Fatalf("upgrade response = %q, want empty", got)
	}
}

func TestHandlePollingPayload_SocketError(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	sid := srv.newSID()
	// Socket.IO error packet (type 4) for namespace /cli
	got := srv.handlePollingPayload(sid, "44/cli,")
	if !strings.Contains(got, "error") {
		t.Fatalf("error response = %q, should contain error", got)
	}
}

func TestHandlePollingPayload_Disconnect(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	sid := srv.newSID()
	srv.trackNamespace(sid, "/cli")

	// Socket.IO disconnect packet (type 1)
	got := srv.handlePollingPayload(sid, "41/cli,")
	if got != "" {
		t.Fatalf("disconnect response = %q, want empty", got)
	}

	// Namespace should be untracked
	srv.sessMu.RLock()
	sess := srv.sessions[sid]
	_, hasNS := sess.Namespaces["/cli"]
	srv.sessMu.RUnlock()
	if hasNS {
		t.Fatal("namespace should be untracked after disconnect")
	}
}

// --- RPC ---

func TestServer_SendRpc_NoConn(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	_, _, err := srv.SendRpc("sync", map[string]string{"test": "true"})
	if err == nil {
		t.Fatal("expected error when no RPC connection")
	}
}

func TestServer_RegisterUnregisterRpc(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	conn := &wsConn{}
	srv.registerRpcMethod("sync", conn)

	got := srv.getRpcConn("sync")
	if got != conn {
		t.Fatal("getRpcConn should return registered conn")
	}

	srv.unregisterRpcMethod("sync", conn)
	got = srv.getRpcConn("sync")
	if got != nil {
		t.Fatal("getRpcConn should return nil after unregister")
	}
}

func TestServer_UnregisterRpcConn(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	conn := &wsConn{}
	srv.registerRpcMethod("sync", conn)
	srv.registerRpcMethod("other", conn)

	srv.unregisterRpcConn(conn)

	if srv.getRpcConn("sync") != nil {
		t.Fatal("sync should be unregistered")
	}
	if srv.getRpcConn("other") != nil {
		t.Fatal("other should be unregistered")
	}
}

// --- Ack lifecycle ---

func TestServer_AckLifecycle(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	id := srv.nextAckID()
	if id == "" {
		t.Fatal("ackID should not be empty")
	}

	ch := srv.registerAck(id)
	if ch == nil {
		t.Fatal("channel should not be nil")
	}

	srv.resolveAck(id, `["result"]`)
	select {
	case val := <-ch:
		if string(val) != `"result"` {
			t.Fatalf("ack value = %s, want \"result\"", val)
		}
	default:
		t.Fatal("channel should have value")
	}

	// Resolving unknown ack should not panic
	srv.resolveAck("nonexistent", `["x"]`)
}

func TestServer_NextAckID_Increments(t *testing.T) {
	srv := newTestServer()
	defer srv.Stop()

	id1 := srv.nextAckID()
	id2 := srv.nextAckID()
	if id1 == id2 {
		t.Fatal("consecutive ack IDs should be different")
	}
}
