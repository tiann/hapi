package sse

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

func HandleEvents(w http.ResponseWriter, req *http.Request, bus *Bus, tracker *VisibilityTracker, namespace string, all bool, visibility string) {
	header := w.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-cache")
	header.Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	subscriptionID := NewSubscriptionID()
	if tracker != nil {
		tracker.Register(subscriptionID, namespace)
		if visibility != "" {
			tracker.SetVisibility(subscriptionID, namespace, visibility)
		}
		defer tracker.Unregister(subscriptionID)
	}
	writeEvent(w, flusher, Event{
		Type: "connection-changed",
		Data: map[string]any{
			"status":         "connected",
			"subscriptionId": subscriptionID,
		},
	})

	query := req.URL.Query()
	sessionFilter := query.Get("sessionId")
	machineFilter := query.Get("machineId")

	events := bus.Subscribe(32)
	defer bus.Unsubscribe(events)

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-req.Context().Done():
			return
		case event := <-events:
			if eventMatches(event, namespace, sessionFilter, machineFilter, all) {
				writeEvent(w, flusher, event)
			}
		case <-ticker.C:
			fmt.Fprint(w, ": heartbeat\n\n")
			flusher.Flush()
		}
	}
}

func writeEvent(w http.ResponseWriter, flusher http.Flusher, event Event) {
	payload, err := json.Marshal(event.Data)
	if err != nil {
		return
	}
	fmt.Fprintf(w, "event: %s\n", event.Type)
	fmt.Fprintf(w, "data: %s\n\n", payload)
	flusher.Flush()
}

func eventMatches(event Event, namespace string, sessionID string, machineID string, all bool) bool {
	if event.Type != "connection-changed" {
		if raw, ok := event.Data["namespace"]; ok {
			if value, ok := raw.(string); ok && value != namespace {
				return false
			}
		} else {
			return false
		}
	}
	if event.Type == "message-received" {
		if sessionID == "" {
			return false
		}
		if raw, ok := event.Data["sessionId"]; ok {
			if value, ok := raw.(string); ok && value == sessionID {
				return true
			}
		}
		return false
	}
	if all {
		return true
	}
	if sessionID == "" && machineID == "" {
		return false
	}
	if sessionID != "" {
		if raw, ok := event.Data["sessionId"]; ok {
			if value, ok := raw.(string); ok && value == sessionID {
				return true
			}
		}
		return false
	}
	if machineID != "" {
		if raw, ok := event.Data["machineId"]; ok {
			if value, ok := raw.(string); ok && value == machineID {
				return true
			}
		}
		return false
	}
	return true
}
