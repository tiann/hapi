package notifications

import "hub_go/internal/sync"

type eventEnvelope struct {
	Type any
	Data any
}

func extractEventEnvelope(message any) *eventEnvelope {
	obj, ok := message.(map[string]any)
	if !ok {
		return nil
	}
	if obj["type"] == "event" {
		return &eventEnvelope{Type: obj["type"], Data: obj["data"]}
	}
	content, ok := obj["content"].(map[string]any)
	if !ok || content["type"] != "event" {
		return nil
	}
	return &eventEnvelope{Type: content["type"], Data: content["data"]}
}

func extractMessageEventType(event sync.SyncEvent) string {
	if event.Type != "message-received" {
		return ""
	}
	message := event.Message
	if message == nil {
		return ""
	}
	envelope := extractEventEnvelope(message["content"])
	if envelope == nil {
		return ""
	}
	data, ok := envelope.Data.(map[string]any)
	if !ok {
		return ""
	}
	eventType, _ := data["type"].(string)
	return eventType
}
