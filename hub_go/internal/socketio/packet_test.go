package socketio

import (
	"testing"
)

func TestParseEnginePayload(t *testing.T) {
	tests := []struct {
		name    string
		payload string
		want    int
	}{
		{"empty", "", 0},
		{"single", "4hello", 1},
		{"multiple", "4hello\x1e4world", 2},
		{"three", "a\x1eb\x1ec", 3},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseEnginePayload(tt.payload)
			if len(got) != tt.want {
				t.Fatalf("parseEnginePayload(%q) = %d parts, want %d", tt.payload, len(got), tt.want)
			}
		})
	}
}

func TestParseSocketMessage(t *testing.T) {
	tests := []struct {
		name      string
		raw       string
		wantNil   bool
		wantNS    string
		wantType  SocketPacketType
		wantData  string
	}{
		{"empty", "", true, "", 0, ""},
		{"invalid byte", "hello", true, "", 0, ""},
		{"connect root", "0", false, "/", SocketConnect, ""},
		{"connect with ns", "0/cli,", false, "/cli", SocketConnect, ""},
		{"connect ns no comma", "0/cli", false, "/cli", SocketConnect, ""},
		{"event root", "2[\"hello\",{}]", false, "/", SocketEvent, "[\"hello\",{}]"},
		{"event ns", "2/cli,[\"msg\",{\"text\":\"hi\"}]", false, "/cli", SocketEvent, "[\"msg\",{\"text\":\"hi\"}]"},
		{"ack root", "3[\"ok\"]", false, "/", SocketAck, "[\"ok\"]"},
		{"error ns", "4/cli,{\"message\":\"fail\"}", false, "/cli", SocketError, "{\"message\":\"fail\"}"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseSocketMessage(tt.raw)
			if tt.wantNil {
				if got != nil {
					t.Fatalf("expected nil, got %+v", got)
				}
				return
			}
			if got == nil {
				t.Fatal("expected non-nil")
			}
			if got.Namespace != tt.wantNS {
				t.Fatalf("Namespace = %q, want %q", got.Namespace, tt.wantNS)
			}
			if got.Type != tt.wantType {
				t.Fatalf("Type = %c, want %c", got.Type, tt.wantType)
			}
			if got.Data != tt.wantData {
				t.Fatalf("Data = %q, want %q", got.Data, tt.wantData)
			}
		})
	}
}

func TestEncodeSocketAck(t *testing.T) {
	tests := []struct {
		ns   string
		want string
	}{
		{"/", "3[]"},
		{"", "3[]"},
		{"/cli", "3/cli,[]"},
	}
	for _, tt := range tests {
		t.Run(tt.ns, func(t *testing.T) {
			got := encodeSocketAck(tt.ns)
			if got != tt.want {
				t.Fatalf("encodeSocketAck(%q) = %q, want %q", tt.ns, got, tt.want)
			}
		})
	}
}

func TestEncodeSocketError(t *testing.T) {
	got := encodeSocketError("/cli", "auth failed")
	if got != `4/cli,{"message":"auth failed"}` {
		t.Fatalf("got %q", got)
	}
	got2 := encodeSocketError("/", "bad")
	if got2 != `4{"message":"bad"}` {
		t.Fatalf("got %q", got2)
	}
}

func TestParseSocketEventPayload(t *testing.T) {
	tests := []struct {
		name      string
		raw       string
		wantEvent string
		wantOK    bool
	}{
		{"empty", "", "", false},
		{"invalid json", "not json", "", false},
		{"empty array", "[]", "", false},
		{"event only", `["hello"]`, "hello", true},
		{"event with data", `["message",{"text":"hi"}]`, "message", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			event, data, ok := parseSocketEventPayload(tt.raw)
			if ok != tt.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tt.wantOK)
			}
			if !ok {
				return
			}
			if event != tt.wantEvent {
				t.Fatalf("event = %q, want %q", event, tt.wantEvent)
			}
			if tt.name == "event only" && string(data) != `{}` {
				t.Fatalf("data for event-only = %s, want {}", data)
			}
			if tt.name == "event with data" && string(data) != `{"text":"hi"}` {
				t.Fatalf("data = %s", data)
			}
		})
	}
}
