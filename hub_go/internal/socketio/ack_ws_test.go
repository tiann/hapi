package socketio

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// --- ack.go tests ---

func TestEncodeSocketAckWithID_DefaultNamespace(t *testing.T) {
	got := encodeSocketAckWithID("/", "42")
	if got != "342[]" {
		t.Fatalf("got %q, want %q", got, "342[]")
	}
}

func TestEncodeSocketAckWithID_CustomNamespace(t *testing.T) {
	got := encodeSocketAckWithID("/cli", "7")
	if got != "3/cli,7[]" {
		t.Fatalf("got %q, want %q", got, "3/cli,7[]")
	}
}

func TestEncodeSocketAckWithID_EmptyAckID(t *testing.T) {
	got := encodeSocketAckWithID("/cli", "")
	want := encodeSocketAck("/cli")
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestEncodeSocketAckWithIDPayload_DefaultNamespace(t *testing.T) {
	got := encodeSocketAckWithIDPayload("/", "5", map[string]string{"ok": "true"})
	if !strings.HasPrefix(got, "35") {
		t.Fatalf("should start with '35', got %q", got)
	}
	if !strings.Contains(got, `"ok"`) {
		t.Fatalf("should contain payload: %q", got)
	}
}

func TestEncodeSocketAckWithIDPayload_CustomNamespace(t *testing.T) {
	got := encodeSocketAckWithIDPayload("/cli", "3", "hello")
	if !strings.HasPrefix(got, "3/cli,3") {
		t.Fatalf("should start with '3/cli,3', got %q", got)
	}
}

func TestEncodeSocketAckWithIDPayload_EmptyAckID(t *testing.T) {
	got := encodeSocketAckWithIDPayload("/", "", "data")
	want := encodeSocketAck("/")
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestParseSocketAckID(t *testing.T) {
	tests := []struct {
		raw    string
		wantID string
		wantRm string
	}{
		{"", "", ""},
		{"42[\"ok\"]", "42", "[\"ok\"]"},
		{"123", "123", ""},
		{"abc", "", "abc"},
		{"0rest", "0", "rest"},
	}
	for _, tt := range tests {
		id, rm := parseSocketAckID(tt.raw)
		if id != tt.wantID || rm != tt.wantRm {
			t.Errorf("parseSocketAckID(%q) = (%q, %q), want (%q, %q)", tt.raw, id, rm, tt.wantID, tt.wantRm)
		}
	}
}

func TestEncodeSocketEvent_DefaultNamespace(t *testing.T) {
	got := encodeSocketEvent("/", "message", map[string]string{"text": "hi"})
	if !strings.HasPrefix(got, "2") {
		t.Fatalf("should start with '2', got %q", got)
	}
	if !strings.Contains(got, "message") {
		t.Fatalf("should contain event name: %q", got)
	}
	if !strings.Contains(got, "hi") {
		t.Fatalf("should contain payload: %q", got)
	}
}

func TestEncodeSocketEvent_CustomNamespace(t *testing.T) {
	got := encodeSocketEvent("/cli", "update", nil)
	if !strings.HasPrefix(got, "2/cli,") {
		t.Fatalf("should start with '2/cli,', got %q", got)
	}
}

func TestEncodeSocketEventWithID(t *testing.T) {
	got := encodeSocketEventWithID("/cli", "42", "message", "hello")
	if !strings.HasPrefix(got, "2/cli,42") {
		t.Fatalf("should start with '2/cli,42', got %q", got)
	}
}

func TestParseAckPayload(t *testing.T) {
	tests := []struct {
		raw  string
		want string
	}{
		{"", "null"},
		{"[]", "null"},
		{`["hello"]`, `"hello"`},
		{`[{"ok":true}]`, `{"ok":true}`},
		{`[1,2,3]`, "1"}, // returns first element
		{"not-json", "null"},
	}
	for _, tt := range tests {
		got := parseAckPayload(tt.raw)
		if string(got) != tt.want {
			t.Errorf("parseAckPayload(%q) = %s, want %s", tt.raw, got, tt.want)
		}
	}
}

// --- sid.go tests ---

func TestNewSID_Format(t *testing.T) {
	sid := newSID()
	if len(sid) != 32 {
		t.Fatalf("SID length = %d, want 32 hex chars", len(sid))
	}
	// Should be valid hex
	for _, c := range sid {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			t.Fatalf("SID contains non-hex char: %q in %q", string(c), sid)
		}
	}
}

func TestNewSID_Unique(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		sid := newSID()
		if seen[sid] {
			t.Fatalf("duplicate SID: %q", sid)
		}
		seen[sid] = true
	}
}

// --- websocket.go utility tests ---

func TestIsWebsocketUpgrade(t *testing.T) {
	tests := []struct {
		name    string
		headers map[string]string
		want    bool
	}{
		{"valid", map[string]string{"Upgrade": "websocket", "Connection": "Upgrade"}, true},
		{"case insensitive", map[string]string{"Upgrade": "WebSocket", "Connection": "upgrade"}, true},
		{"keep-alive upgrade", map[string]string{"Upgrade": "websocket", "Connection": "keep-alive, Upgrade"}, true},
		{"no upgrade header", map[string]string{"Connection": "Upgrade"}, false},
		{"no connection header", map[string]string{"Upgrade": "websocket"}, false},
		{"wrong upgrade", map[string]string{"Upgrade": "h2c", "Connection": "Upgrade"}, false},
		{"nil request", map[string]string{}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.name == "nil request" {
				if isWebsocketUpgrade(nil) {
					t.Fatal("nil request should return false")
				}
				return
			}
			req, _ := http.NewRequest("GET", "/", nil)
			for k, v := range tt.headers {
				req.Header.Set(k, v)
			}
			if got := isWebsocketUpgrade(req); got != tt.want {
				t.Fatalf("got %v, want %v", got, tt.want)
			}
		})
	}
}

func TestComputeWebsocketAccept(t *testing.T) {
	// RFC 6455 Section 4.2.2 example
	key := "dGhlIHNhbXBsZSBub25jZQ=="
	want := "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
	got := computeWebsocketAccept(key)
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestEncodeTextFrame_Short(t *testing.T) {
	frame := encodeTextFrame("hello")
	if frame[0] != 0x81 {
		t.Fatalf("first byte = %x, want 0x81 (text frame)", frame[0])
	}
	if frame[1] != 5 {
		t.Fatalf("length byte = %d, want 5", frame[1])
	}
	if string(frame[2:]) != "hello" {
		t.Fatalf("payload = %q, want hello", string(frame[2:]))
	}
}

func TestEncodeTextFrame_Medium(t *testing.T) {
	payload := strings.Repeat("x", 200)
	frame := encodeTextFrame(payload)
	if frame[0] != 0x81 {
		t.Fatal("invalid opcode")
	}
	if frame[1] != 126 {
		t.Fatalf("length indicator = %d, want 126 (extended 16-bit)", frame[1])
	}
	// Bytes 2-3 should be uint16(200)
	length := int(frame[2])<<8 | int(frame[3])
	if length != 200 {
		t.Fatalf("extended length = %d, want 200", length)
	}
}

func TestReadWebsocketFrame_Unmasked(t *testing.T) {
	// Build a simple unmasked text frame
	frame := encodeTextFrame("test")
	r := bufio.NewReader(bytes.NewReader(frame))
	opcode, payload, err := readWebsocketFrame(r)
	if err != nil {
		t.Fatalf("readWebsocketFrame error: %v", err)
	}
	if opcode != 0x01 {
		t.Fatalf("opcode = %x, want 0x01", opcode)
	}
	if string(payload) != "test" {
		t.Fatalf("payload = %q, want test", string(payload))
	}
}

func TestReadWebsocketFrame_Masked(t *testing.T) {
	// Build a masked frame manually
	data := []byte("hi")
	mask := []byte{0x12, 0x34, 0x56, 0x78}
	maskedData := make([]byte, len(data))
	for i, b := range data {
		maskedData[i] = b ^ mask[i%4]
	}

	var buf bytes.Buffer
	buf.WriteByte(0x81)                       // text frame
	buf.WriteByte(0x80 | byte(len(data)))     // masked + length
	buf.Write(mask)                           // mask key
	buf.Write(maskedData)                     // masked payload

	r := bufio.NewReader(&buf)
	opcode, payload, err := readWebsocketFrame(r)
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if opcode != 0x01 {
		t.Fatalf("opcode = %x, want 0x01", opcode)
	}
	if string(payload) != "hi" {
		t.Fatalf("payload = %q, want hi", string(payload))
	}
}

// --- events.go utility tests ---

func TestParseInt64(t *testing.T) {
	tests := []struct {
		input any
		want  int64
	}{
		{float64(42), 42},
		{int64(100), 100},
		{int(7), 7},
		{json.Number("123"), 123},
		{"not a number", 0},
		{nil, 0},
		{true, 0},
	}
	for _, tt := range tests {
		got := parseInt64(tt.input)
		if got != tt.want {
			t.Errorf("parseInt64(%v) = %d, want %d", tt.input, got, tt.want)
		}
	}
}

func TestGetString(t *testing.T) {
	tests := []struct {
		input any
		want  string
	}{
		{"hello", "hello"},
		{nil, ""},
		{42, ""},
		{"", ""},
	}
	for _, tt := range tests {
		got := getString(tt.input)
		if got != tt.want {
			t.Errorf("getString(%v) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestNullableString(t *testing.T) {
	if nullableString("") != nil {
		t.Fatal("empty string should return nil")
	}
	if nullableString("hello") != "hello" {
		t.Fatal("non-empty string should return itself")
	}
}

func TestParseMessageContent(t *testing.T) {
	tests := []struct {
		name string
		raw  any
		want string // JSON representation of result
	}{
		{"nil", nil, "null"},
		{"json object string", `{"key":"value"}`, `{"key":"value"}`},
		{"plain string", "hello world", `"hello world"`},
		{"number", float64(42), "42"},
		{"json array string", `[1,2,3]`, "[1,2,3]"},
		{"invalid json string", "not { json", `"not { json"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseMessageContent(tt.raw)
			gotJSON, _ := json.Marshal(got)
			if string(gotJSON) != tt.want {
				t.Fatalf("got %s, want %s", gotJSON, tt.want)
			}
		})
	}
}

func TestParseRpcMethod(t *testing.T) {
	tests := []struct {
		payload string
		method  string
		ok      bool
	}{
		{`{"method":"sync"}`, "sync", true},
		{`{"method":""}`, "", false},
		{`{"other":"field"}`, "", false},
		{`{}`, "", false},
		{``, "", false},
		{`invalid`, "", false},
	}
	for _, tt := range tests {
		method, ok := parseRpcMethod(json.RawMessage(tt.payload))
		if method != tt.method || ok != tt.ok {
			t.Errorf("parseRpcMethod(%q) = (%q, %v), want (%q, %v)", tt.payload, method, ok, tt.method, tt.ok)
		}
	}
}

// --- handler.go utility tests ---

func TestExtractAuthTokenAndTargets(t *testing.T) {
	tests := []struct {
		name      string
		raw       string
		token     string
		sessionID string
		machineID string
	}{
		{"empty", "", "", "", ""},
		{"spaces only", "   ", "", "", ""},
		{"token only", `{"token":"abc123"}`, "abc123", "", ""},
		{"all fields", `{"token":"tk","sessionId":"s1","machineId":"m1"}`, "tk", "s1", "m1"},
		{"no token", `{"sessionId":"s1"}`, "", "s1", ""},
		{"invalid json", "not-json", "", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			token, sid, mid := extractAuthTokenAndTargets(tt.raw)
			if token != tt.token || sid != tt.sessionID || mid != tt.machineID {
				t.Fatalf("got (%q,%q,%q), want (%q,%q,%q)", token, sid, mid, tt.token, tt.sessionID, tt.machineID)
			}
		})
	}
}

func TestMustJSON(t *testing.T) {
	got := mustJSON(map[string]int{"a": 1})
	if got != `{"a":1}` {
		t.Fatalf("got %q, want {\"a\":1}", got)
	}
}

func TestEncodeSocketConnect(t *testing.T) {
	// Root namespace
	got := encodeSocketConnect("/")
	if !strings.HasPrefix(got, "0{") {
		t.Fatalf("root ns: got %q, want prefix '0{'", got)
	}
	if !strings.Contains(got, `"sid"`) {
		t.Fatalf("should contain sid: %q", got)
	}

	// Empty namespace (same as root)
	got = encodeSocketConnect("")
	if !strings.HasPrefix(got, "0{") {
		t.Fatalf("empty ns: got %q, want prefix '0{'", got)
	}

	// Custom namespace
	got = encodeSocketConnect("/cli")
	if !strings.HasPrefix(got, "0/cli,{") {
		t.Fatalf("custom ns: got %q, want prefix '0/cli,{'", got)
	}
}
