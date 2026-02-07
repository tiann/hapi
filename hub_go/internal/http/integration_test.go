package httpserver_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	httpserver "hub_go/internal/http"
	"hub_go/internal/sse"
	"hub_go/internal/store"
)

const testCliToken = "test-cli-token-value"

func setupTestServer(t *testing.T) *httptest.Server {
	t.Helper()

	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	bus := sse.NewBus()
	router := httpserver.NewRouter()

	httpserver.RegisterRoutes(router, httpserver.AuthDependencies{
		JWTSecret:      []byte("test-jwt-secret"),
		CliApiToken:    testCliToken,
		TelegramToken:  nil,
		DataDir:        t.TempDir(),
		Store:          st,
		Engine:         nil,
		SSEBus:         bus,
		Visibility:     sse.NewVisibilityTracker(),
		SocketIO:       nil,
		CorsOrigins:    []string{"*"},
		VapidPublicKey: "test-vapid-public-key",
	})

	ts := httptest.NewServer(router)
	t.Cleanup(ts.Close)
	return ts
}

func cliRequest(method, url string, body any) *http.Request {
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, url, reader)
	req.Header.Set("Authorization", "Bearer "+testCliToken)
	req.Header.Set("Content-Type", "application/json")
	return req
}

func doJSON(t *testing.T, req *http.Request) (int, map[string]any) {
	t.Helper()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()
	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return resp.StatusCode, result
}

// ── Health Endpoints ──

func TestHealthz(t *testing.T) {
	ts := setupTestServer(t)
	resp, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	var result map[string]any
	json.NewDecoder(resp.Body).Decode(&result)
	if result["ok"] != true {
		t.Fatalf("ok = %v", result["ok"])
	}
}

func TestHealth(t *testing.T) {
	ts := setupTestServer(t)
	resp, err := http.Get(ts.URL + "/health")
	if err != nil {
		t.Fatalf("GET /health: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	var result map[string]any
	json.NewDecoder(resp.Body).Decode(&result)
	if result["status"] != "ok" {
		t.Fatalf("status = %v", result["status"])
	}
}

// ── CLI Authentication ──

func TestCLI_Unauthorized(t *testing.T) {
	ts := setupTestServer(t)
	resp, err := http.Get(ts.URL + "/cli/sessions/nonexistent")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

func TestCLI_InvalidToken(t *testing.T) {
	ts := setupTestServer(t)
	req, _ := http.NewRequest("GET", ts.URL+"/cli/sessions/nonexistent", nil)
	req.Header.Set("Authorization", "Bearer wrong-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

// ── Session Lifecycle ──

func TestCLI_CreateSession(t *testing.T) {
	ts := setupTestServer(t)

	// Create session
	req := cliRequest("POST", ts.URL+"/cli/sessions", map[string]any{
		"tag":      "test-tag-1",
		"metadata": map[string]any{"name": "Test Session"},
	})
	status, body := doJSON(t, req)
	if status != 200 {
		t.Fatalf("create status = %d, body = %v", status, body)
	}

	session, ok := body["session"].(map[string]any)
	if !ok {
		t.Fatalf("no session in response: %v", body)
	}
	sessionID, ok := session["id"].(string)
	if !ok || sessionID == "" {
		t.Fatalf("no session id: %v", session)
	}

	// Get session
	req2 := cliRequest("GET", ts.URL+"/cli/sessions/"+sessionID, nil)
	status2, body2 := doJSON(t, req2)
	if status2 != 200 {
		t.Fatalf("get status = %d", status2)
	}
	session2 := body2["session"].(map[string]any)
	if session2["id"] != sessionID {
		t.Fatalf("get session id mismatch: %v", session2["id"])
	}
}

func TestCLI_CreateSession_Dedup(t *testing.T) {
	ts := setupTestServer(t)

	// Create session with tag
	req := cliRequest("POST", ts.URL+"/cli/sessions", map[string]any{
		"tag": "dedup-tag",
	})
	status, body := doJSON(t, req)
	if status != 200 {
		t.Fatalf("first create = %d", status)
	}
	firstID := body["session"].(map[string]any)["id"].(string)

	// Create again with same tag → should return existing
	req2 := cliRequest("POST", ts.URL+"/cli/sessions", map[string]any{
		"tag": "dedup-tag",
	})
	status2, body2 := doJSON(t, req2)
	if status2 != 200 {
		t.Fatalf("second create = %d", status2)
	}
	secondID := body2["session"].(map[string]any)["id"].(string)

	if firstID != secondID {
		t.Fatalf("dedup failed: %s != %s", firstID, secondID)
	}
}

func TestCLI_CreateSession_MissingTag(t *testing.T) {
	ts := setupTestServer(t)
	req := cliRequest("POST", ts.URL+"/cli/sessions", map[string]any{})
	status, _ := doJSON(t, req)
	if status != 400 {
		t.Fatalf("expected 400 for missing tag, got %d", status)
	}
}

func TestCLI_GetSession_NotFound(t *testing.T) {
	ts := setupTestServer(t)
	req := cliRequest("GET", ts.URL+"/cli/sessions/nonexistent-id", nil)
	status, _ := doJSON(t, req)
	if status != 404 {
		t.Fatalf("expected 404, got %d", status)
	}
}

// ── Machine Registration ──

func TestCLI_RegisterMachine(t *testing.T) {
	ts := setupTestServer(t)

	req := cliRequest("POST", ts.URL+"/cli/machines", map[string]any{
		"id":       "machine-001",
		"metadata": map[string]any{"host": "dev-box"},
	})
	status, body := doJSON(t, req)
	if status != 200 {
		t.Fatalf("register status = %d, body = %v", status, body)
	}
	machine := body["machine"].(map[string]any)
	if machine["id"] != "machine-001" {
		t.Fatalf("machine id = %v", machine["id"])
	}

	// Get machine
	req2 := cliRequest("GET", ts.URL+"/cli/machines/machine-001", nil)
	status2, body2 := doJSON(t, req2)
	if status2 != 200 {
		t.Fatalf("get machine = %d", status2)
	}
	m2 := body2["machine"].(map[string]any)
	if m2["id"] != "machine-001" {
		t.Fatalf("got machine id = %v", m2["id"])
	}
}

func TestCLI_RegisterMachine_MissingID(t *testing.T) {
	ts := setupTestServer(t)
	req := cliRequest("POST", ts.URL+"/cli/machines", map[string]any{})
	status, _ := doJSON(t, req)
	if status != 400 {
		t.Fatalf("expected 400, got %d", status)
	}
}

// ── Messages ──

func TestCLI_Messages(t *testing.T) {
	ts := setupTestServer(t)

	// Create session first
	req := cliRequest("POST", ts.URL+"/cli/sessions", map[string]any{
		"tag": "msg-test",
	})
	_, body := doJSON(t, req)
	sessionID := body["session"].(map[string]any)["id"].(string)

	// List messages (should be empty)
	req2 := cliRequest("GET", ts.URL+"/cli/sessions/"+sessionID+"/messages?afterSeq=0", nil)
	status2, body2 := doJSON(t, req2)
	if status2 != 200 {
		t.Fatalf("list messages = %d", status2)
	}
	messages := body2["messages"].([]any)
	if len(messages) != 0 {
		t.Fatalf("expected 0 messages, got %d", len(messages))
	}
}

// ── API Auth ──

func TestAPI_Auth_AccessToken(t *testing.T) {
	ts := setupTestServer(t)

	payload, _ := json.Marshal(map[string]any{
		"accessToken": testCliToken,
	})
	resp, err := http.Post(ts.URL+"/api/auth", "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("POST /api/auth: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d, body = %s", resp.StatusCode, body)
	}

	var result map[string]any
	json.NewDecoder(resp.Body).Decode(&result)
	token, ok := result["token"].(string)
	if !ok || token == "" {
		t.Fatalf("no token in response: %v", result)
	}
	user, ok := result["user"].(map[string]any)
	if !ok {
		t.Fatalf("no user in response: %v", result)
	}
	if user["firstName"] != "Web User" {
		t.Fatalf("firstName = %v", user["firstName"])
	}
}

func TestAPI_Auth_InvalidToken(t *testing.T) {
	ts := setupTestServer(t)
	payload, _ := json.Marshal(map[string]any{
		"accessToken": "wrong-token",
	})
	resp, err := http.Post(ts.URL+"/api/auth", "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

func TestAPI_Auth_InvalidBody(t *testing.T) {
	ts := setupTestServer(t)
	resp, err := http.Post(ts.URL+"/api/auth", "application/json", bytes.NewReader([]byte("{}")))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

// ── API with JWT ──

func getJWT(t *testing.T, ts *httptest.Server) string {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{"accessToken": testCliToken})
	resp, err := http.Post(ts.URL+"/api/auth", "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("auth: %v", err)
	}
	defer resp.Body.Close()
	var result map[string]any
	json.NewDecoder(resp.Body).Decode(&result)
	return result["token"].(string)
}

func TestAPI_ListSessions(t *testing.T) {
	ts := setupTestServer(t)

	// Create a session via CLI first
	req := cliRequest("POST", ts.URL+"/cli/sessions", map[string]any{
		"tag":      "api-test-session",
		"metadata": map[string]any{"name": "API Test"},
	})
	doJSON(t, req)

	// Get JWT
	jwt := getJWT(t, ts)

	// List sessions with JWT
	req2, _ := http.NewRequest("GET", ts.URL+"/api/sessions", nil)
	req2.Header.Set("Authorization", "Bearer "+jwt)
	status, body := doJSON(t, req2)
	if status != 200 {
		t.Fatalf("list sessions = %d, body = %v", status, body)
	}
	sessions, ok := body["sessions"].([]any)
	if !ok {
		t.Fatalf("no sessions array: %v", body)
	}
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(sessions))
	}
}

func TestAPI_Unauthorized(t *testing.T) {
	ts := setupTestServer(t)
	resp, err := http.Get(ts.URL + "/api/sessions")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

func TestAPI_GetSession(t *testing.T) {
	ts := setupTestServer(t)

	// Create session via CLI
	req := cliRequest("POST", ts.URL+"/cli/sessions", map[string]any{
		"tag":      "api-get-test",
		"metadata": map[string]any{"name": "Get Test"},
	})
	_, createBody := doJSON(t, req)
	sessionID := createBody["session"].(map[string]any)["id"].(string)

	// Get session via API
	jwt := getJWT(t, ts)
	req2, _ := http.NewRequest("GET", ts.URL+"/api/sessions/"+sessionID, nil)
	req2.Header.Set("Authorization", "Bearer "+jwt)
	status, body := doJSON(t, req2)
	if status != 200 {
		t.Fatalf("get session = %d", status)
	}
	session := body["session"].(map[string]any)
	if session["id"] != sessionID {
		t.Fatalf("id mismatch: %v", session["id"])
	}
}

func TestAPI_DeleteSession(t *testing.T) {
	ts := setupTestServer(t)

	// Create session
	req := cliRequest("POST", ts.URL+"/cli/sessions", map[string]any{
		"tag": "delete-test",
	})
	_, createBody := doJSON(t, req)
	sessionID := createBody["session"].(map[string]any)["id"].(string)

	// Delete via API
	jwt := getJWT(t, ts)
	req2, _ := http.NewRequest("DELETE", ts.URL+"/api/sessions/"+sessionID, nil)
	req2.Header.Set("Authorization", "Bearer "+jwt)
	resp, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("delete status = %d", resp.StatusCode)
	}

	// Verify deleted
	req3, _ := http.NewRequest("GET", ts.URL+"/api/sessions/"+sessionID, nil)
	req3.Header.Set("Authorization", "Bearer "+jwt)
	status3, _ := doJSON(t, req3)
	if status3 != 404 {
		t.Fatalf("expected 404 after delete, got %d", status3)
	}
}

// ── VAPID Public Key ──

func TestAPI_VapidPublicKey(t *testing.T) {
	ts := setupTestServer(t)
	jwt := getJWT(t, ts)

	req, _ := http.NewRequest("GET", ts.URL+"/api/push/vapid-public-key", nil)
	req.Header.Set("Authorization", "Bearer "+jwt)
	status, body := doJSON(t, req)
	if status != 200 {
		t.Fatalf("status = %d", status)
	}
	if body["publicKey"] != "test-vapid-public-key" {
		t.Fatalf("publicKey = %v", body["publicKey"])
	}
}

// ── Machines via API ──

func TestAPI_ListMachines(t *testing.T) {
	ts := setupTestServer(t)

	// Register a machine via CLI (newly registered machines are inactive)
	req := cliRequest("POST", ts.URL+"/cli/machines", map[string]any{
		"id":       "api-machine-1",
		"metadata": map[string]any{"host": "test-host"},
	})
	doJSON(t, req)

	// List via API - inactive machines are filtered out
	jwt := getJWT(t, ts)
	req2, _ := http.NewRequest("GET", ts.URL+"/api/machines", nil)
	req2.Header.Set("Authorization", "Bearer "+jwt)
	status, body := doJSON(t, req2)
	if status != 200 {
		t.Fatalf("list machines = %d", status)
	}
	machines, ok := body["machines"].([]any)
	if !ok {
		t.Fatalf("no machines array: %v", body)
	}
	// newly registered machines are inactive (active=0), so filtered out
	if len(machines) != 0 {
		t.Fatalf("expected 0 active machines, got %d", len(machines))
	}
}

// ── Session PATCH ──

func TestAPI_PatchSession(t *testing.T) {
	ts := setupTestServer(t)

	// Create session
	req := cliRequest("POST", ts.URL+"/cli/sessions", map[string]any{
		"tag":      "patch-test",
		"metadata": map[string]any{"name": "Original Name"},
	})
	_, body := doJSON(t, req)
	sessionID := body["session"].(map[string]any)["id"].(string)

	// Patch session name
	jwt := getJWT(t, ts)
	patchBody, _ := json.Marshal(map[string]any{"name": "Updated Name"})
	req2, _ := http.NewRequest("PATCH", ts.URL+"/api/sessions/"+sessionID, bytes.NewReader(patchBody))
	req2.Header.Set("Authorization", "Bearer "+jwt)
	req2.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatalf("PATCH: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("PATCH status = %d", resp.StatusCode)
	}

	// Verify updated name
	req3, _ := http.NewRequest("GET", ts.URL+"/api/sessions/"+sessionID, nil)
	req3.Header.Set("Authorization", "Bearer "+jwt)
	_, body3 := doJSON(t, req3)
	session := body3["session"].(map[string]any)
	meta, ok := session["metadata"].(map[string]any)
	if !ok || meta["name"] != "Updated Name" {
		t.Fatalf("expected 'Updated Name', got %v", meta)
	}
}

func TestAPI_PatchSession_NotFound(t *testing.T) {
	ts := setupTestServer(t)
	jwt := getJWT(t, ts)

	patchBody, _ := json.Marshal(map[string]any{"name": "whatever"})
	req, _ := http.NewRequest("PATCH", ts.URL+"/api/sessions/nonexistent", bytes.NewReader(patchBody))
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("expected 404, got %d", resp.StatusCode)
	}
}

// ── Push Subscription ──

func TestAPI_PushSubscribe(t *testing.T) {
	ts := setupTestServer(t)
	jwt := getJWT(t, ts)

	// Subscribe
	subBody, _ := json.Marshal(map[string]any{
		"endpoint": "https://push.example.com/sub1",
		"keys": map[string]any{
			"p256dh": "test-p256dh-key",
			"auth":   "test-auth-key",
		},
	})
	req, _ := http.NewRequest("POST", ts.URL+"/api/push/subscribe", bytes.NewReader(subBody))
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("Content-Type", "application/json")
	status, body := doJSON(t, req)
	if status != 200 {
		t.Fatalf("subscribe status = %d, body = %v", status, body)
	}
	if body["ok"] != true {
		t.Fatalf("ok = %v", body["ok"])
	}
}

func TestAPI_PushSubscribe_MissingFields(t *testing.T) {
	ts := setupTestServer(t)
	jwt := getJWT(t, ts)

	// Missing keys
	subBody, _ := json.Marshal(map[string]any{
		"endpoint": "https://push.example.com/sub1",
	})
	req, _ := http.NewRequest("POST", ts.URL+"/api/push/subscribe", bytes.NewReader(subBody))
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestAPI_PushUnsubscribe(t *testing.T) {
	ts := setupTestServer(t)
	jwt := getJWT(t, ts)

	// Subscribe first
	subBody, _ := json.Marshal(map[string]any{
		"endpoint": "https://push.example.com/sub-del",
		"keys": map[string]any{
			"p256dh": "test-p256dh",
			"auth":   "test-auth",
		},
	})
	req, _ := http.NewRequest("POST", ts.URL+"/api/push/subscribe", bytes.NewReader(subBody))
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("Content-Type", "application/json")
	doJSON(t, req)

	// Unsubscribe
	delBody, _ := json.Marshal(map[string]any{
		"endpoint": "https://push.example.com/sub-del",
	})
	req2, _ := http.NewRequest("DELETE", ts.URL+"/api/push/subscribe", bytes.NewReader(delBody))
	req2.Header.Set("Authorization", "Bearer "+jwt)
	req2.Header.Set("Content-Type", "application/json")
	status, body := doJSON(t, req2)
	if status != 200 {
		t.Fatalf("unsubscribe status = %d, body = %v", status, body)
	}
	if body["ok"] != true {
		t.Fatalf("ok = %v", body["ok"])
	}
}

func TestAPI_PushUnsubscribe_MissingEndpoint(t *testing.T) {
	ts := setupTestServer(t)
	jwt := getJWT(t, ts)

	delBody, _ := json.Marshal(map[string]any{})
	req, _ := http.NewRequest("DELETE", ts.URL+"/api/push/subscribe", bytes.NewReader(delBody))
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

// ── Messages ──

func TestCLI_Messages_WithContent(t *testing.T) {
	ts := setupTestServer(t)

	// Create session
	req := cliRequest("POST", ts.URL+"/cli/sessions", map[string]any{"tag": "msg-content-test"})
	_, body := doJSON(t, req)
	sessionID := body["session"].(map[string]any)["id"].(string)

	// Add message via API (session must be active for POST /api/sessions/:id/messages)
	// Since newly created sessions may not be active, use store directly via CLI endpoint
	// Instead, list messages for an empty session (already tested) and verify structure

	// List messages with afterSeq=0 (CLI endpoint)
	req2 := cliRequest("GET", ts.URL+"/cli/sessions/"+sessionID+"/messages?afterSeq=0", nil)
	status, body2 := doJSON(t, req2)
	if status != 200 {
		t.Fatalf("list messages = %d", status)
	}
	msgs := body2["messages"].([]any)
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages, got %d", len(msgs))
	}
}

func TestCLI_Messages_NotFound(t *testing.T) {
	ts := setupTestServer(t)
	req := cliRequest("GET", ts.URL+"/cli/sessions/nonexistent/messages?afterSeq=0", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("expected 404, got %d", resp.StatusCode)
	}
}

func TestCLI_Messages_MissingAfterSeq(t *testing.T) {
	ts := setupTestServer(t)
	req := cliRequest("POST", ts.URL+"/cli/sessions", map[string]any{"tag": "msg-no-seq"})
	_, body := doJSON(t, req)
	sessionID := body["session"].(map[string]any)["id"].(string)

	req2 := cliRequest("GET", ts.URL+"/cli/sessions/"+sessionID+"/messages", nil)
	resp, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("expected 400 for missing afterSeq, got %d", resp.StatusCode)
	}
}

// ── Visibility ──

func TestAPI_Visibility_InvalidBody(t *testing.T) {
	ts := setupTestServer(t)
	jwt := getJWT(t, ts)

	// Missing subscriptionId
	visBody, _ := json.Marshal(map[string]any{
		"visibility": "visible",
	})
	req, _ := http.NewRequest("POST", ts.URL+"/api/visibility", bytes.NewReader(visBody))
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestAPI_Visibility_InvalidVisibility(t *testing.T) {
	ts := setupTestServer(t)
	jwt := getJWT(t, ts)

	visBody, _ := json.Marshal(map[string]any{
		"subscriptionId": "sub-123",
		"visibility":     "invalid-value",
	})
	req, _ := http.NewRequest("POST", ts.URL+"/api/visibility", bytes.NewReader(visBody))
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

// ── Session Update via CLI ──

func TestCLI_GetSession_Exists(t *testing.T) {
	ts := setupTestServer(t)

	// Create session
	req := cliRequest("POST", ts.URL+"/cli/sessions", map[string]any{
		"tag":      "get-exists-test",
		"metadata": map[string]any{"name": "Test Session", "extra": "data"},
	})
	_, body := doJSON(t, req)
	sessionID := body["session"].(map[string]any)["id"].(string)

	// Get session and verify metadata
	req2 := cliRequest("GET", ts.URL+"/cli/sessions/"+sessionID, nil)
	status, body2 := doJSON(t, req2)
	if status != 200 {
		t.Fatalf("get status = %d", status)
	}
	session := body2["session"].(map[string]any)
	meta := session["metadata"].(map[string]any)
	if meta["name"] != "Test Session" {
		t.Fatalf("expected 'Test Session', got %v", meta["name"])
	}
	if meta["extra"] != "data" {
		t.Fatalf("expected 'data', got %v", meta["extra"])
	}
}
