package socketio

import (
	"encoding/json"
)

func encodeSocketAckWithID(namespace string, ackID string) string {
	if ackID == "" {
		return encodeSocketAck(namespace)
	}
	payload := "[]"
	if namespace == "/" || namespace == "" {
		return string(SocketAck) + ackID + payload
	}
	return string(SocketAck) + namespace + "," + ackID + payload
}

func encodeSocketAckWithIDPayload(namespace string, ackID string, payload any) string {
	if ackID == "" {
		return encodeSocketAck(namespace)
	}
	raw, _ := json.Marshal([]any{payload})
	if namespace == "/" || namespace == "" {
		return string(SocketAck) + ackID + string(raw)
	}
	return string(SocketAck) + namespace + "," + ackID + string(raw)
}

func parseSocketAckID(raw string) (string, string) {
	if raw == "" {
		return "", ""
	}
	idx := 0
	for idx < len(raw) {
		c := raw[idx]
		if c < '0' || c > '9' {
			break
		}
		idx++
	}
	if idx == 0 {
		return "", raw
	}
	return raw[:idx], raw[idx:]
}

func encodeSocketEvent(namespace string, event string, data any) string {
	payload := []any{event, data}
	raw, _ := json.Marshal(payload)
	if namespace == "/" || namespace == "" {
		return string(SocketEvent) + string(raw)
	}
	return string(SocketEvent) + namespace + "," + string(raw)
}

func encodeSocketEventWithID(namespace string, ackID string, event string, data any) string {
	payload := []any{event, data}
	raw, _ := json.Marshal(payload)
	if namespace == "/" || namespace == "" {
		return string(SocketEvent) + ackID + string(raw)
	}
	return string(SocketEvent) + namespace + "," + ackID + string(raw)
}

func parseAckPayload(raw string) json.RawMessage {
	if raw == "" {
		return json.RawMessage("null")
	}
	var payload []json.RawMessage
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return json.RawMessage("null")
	}
	if len(payload) == 0 {
		return json.RawMessage("null")
	}
	return payload[0]
}
