package socketio

import (
	"encoding/json"
	"strings"
)

type EnginePacketType byte

type SocketPacketType byte

const (
	EngineOpen    EnginePacketType = '0'
	EngineClose   EnginePacketType = '1'
	EnginePing    EnginePacketType = '2'
	EnginePong    EnginePacketType = '3'
	EngineMessage EnginePacketType = '4'
	EngineUpgrade EnginePacketType = '5'
	EngineNoop    EnginePacketType = '6'
)

const (
	SocketConnect    SocketPacketType = '0'
	SocketDisconnect SocketPacketType = '1'
	SocketEvent      SocketPacketType = '2'
	SocketAck        SocketPacketType = '3'
	SocketError      SocketPacketType = '4'
)

type SocketMessage struct {
	Namespace string
	Type      SocketPacketType
	Data      string
}

func parseEnginePayload(payload string) []string {
	if payload == "" {
		return nil
	}
	parts := strings.Split(payload, "\x1e")
	return parts
}

func parseSocketMessage(raw string) *SocketMessage {
	if raw == "" {
		return nil
	}
	typeByte := raw[0]
	if typeByte < '0' || typeByte > '9' {
		return nil
	}
	remaining := raw[1:]
	namespace := "/"
	if strings.HasPrefix(remaining, "/") {
		idx := strings.Index(remaining, ",")
		if idx == -1 {
			return &SocketMessage{Namespace: remaining, Type: SocketPacketType(typeByte)}
		}
		namespace = remaining[:idx]
		remaining = remaining[idx+1:]
	}
	return &SocketMessage{Namespace: namespace, Type: SocketPacketType(typeByte), Data: remaining}
}

func encodeSocketConnect(namespace string) string {
	payload := map[string]any{"sid": newSID()}
	raw, _ := json.Marshal(payload)
	if namespace == "/" || namespace == "" {
		return string(SocketConnect) + string(raw)
	}
	return string(SocketConnect) + namespace + "," + string(raw)
}

func encodeSocketAck(namespace string) string {
	if namespace == "/" || namespace == "" {
		return string(SocketAck) + "[]"
	}
	return string(SocketAck) + namespace + ",[]"
}

func encodeSocketError(namespace string, message string) string {
	payload := map[string]any{"message": message}
	raw, _ := json.Marshal(payload)
	if namespace == "/" || namespace == "" {
		return string(SocketError) + string(raw)
	}
	return string(SocketError) + namespace + "," + string(raw)
}

func parseSocketEventPayload(raw string) (string, json.RawMessage, bool) {
	if raw == "" {
		return "", nil, false
	}
	var payload []json.RawMessage
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return "", nil, false
	}
	if len(payload) == 0 {
		return "", nil, false
	}
	var eventName string
	if err := json.Unmarshal(payload[0], &eventName); err != nil {
		return "", nil, false
	}
	if len(payload) < 2 {
		return eventName, json.RawMessage(`{}`), true
	}
	return eventName, payload[1], true
}
