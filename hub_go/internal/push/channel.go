package push

import (
	"fmt"
	"log"
	"sort"

	"hub_go/internal/notifications"
	"hub_go/internal/sse"
	"hub_go/internal/store"
)

// NotificationChannel implements the NotificationChannel interface for push notifications
type NotificationChannel struct {
	pushService       *Service
	sseBus            *sse.Bus
	visibilityTracker *sse.VisibilityTracker
}

// NewNotificationChannel creates a new push notification channel
func NewNotificationChannel(
	pushService *Service,
	sseBus *sse.Bus,
	visibilityTracker *sse.VisibilityTracker,
) *NotificationChannel {
	return &NotificationChannel{
		pushService:       pushService,
		sseBus:            sseBus,
		visibilityTracker: visibilityTracker,
	}
}

// SendReady sends a ready notification via push
func (c *NotificationChannel) SendReady(session *store.Session) error {
	if c == nil || session == nil || !session.Active {
		return nil
	}

	agentName := notifications.GetAgentName(session)
	name := notifications.GetSessionName(session)

	payload := PushPayload{
		Title: "Ready for input",
		Body:  fmt.Sprintf("%s is waiting in %s", agentName, name),
		Tag:   fmt.Sprintf("ready-%s", session.ID),
		Data: &PushPayloadData{
			Type:      "ready",
			SessionID: session.ID,
			URL:       buildSessionPath(session.ID),
		},
	}

	// Try to send via SSE first if the user has a visible connection
	if c.visibilityTracker != nil && c.visibilityTracker.HasVisibleConnection(session.Namespace) {
		delivered := c.sendToast(session.Namespace, payload)
		if delivered > 0 {
			return nil
		}
	}

	// Fall back to push notification
	if c.pushService != nil {
		if err := c.pushService.SendToNamespace(session.Namespace, payload); err != nil {
			log.Printf("[PushChannel] Failed to send ready notification: %v", err)
			return err
		}
	}

	return nil
}

// SendPermissionRequest sends a permission request notification via push
func (c *NotificationChannel) SendPermissionRequest(session *store.Session) error {
	if c == nil || session == nil || !session.Active {
		return nil
	}

	name := notifications.GetSessionName(session)
	toolName := getToolName(session)
	body := name
	if toolName != "" {
		body = fmt.Sprintf("%s (%s)", name, toolName)
	}

	payload := PushPayload{
		Title: "Permission Request",
		Body:  body,
		Tag:   fmt.Sprintf("permission-%s", session.ID),
		Data: &PushPayloadData{
			Type:      "permission-request",
			SessionID: session.ID,
			URL:       buildSessionPath(session.ID),
		},
	}

	// Try to send via SSE first if the user has a visible connection
	if c.visibilityTracker != nil && c.visibilityTracker.HasVisibleConnection(session.Namespace) {
		delivered := c.sendToast(session.Namespace, payload)
		if delivered > 0 {
			return nil
		}
	}

	// Fall back to push notification
	if c.pushService != nil {
		if err := c.pushService.SendToNamespace(session.Namespace, payload); err != nil {
			log.Printf("[PushChannel] Failed to send permission notification: %v", err)
			return err
		}
	}

	return nil
}

func (c *NotificationChannel) sendToast(namespace string, payload PushPayload) int {
	if c.sseBus == nil {
		return 0
	}

	url := ""
	sessionID := ""
	if payload.Data != nil {
		url = payload.Data.URL
		sessionID = payload.Data.SessionID
	}

	event := sse.Event{
		Type: "toast",
		Data: map[string]any{
			"title":     payload.Title,
			"body":      payload.Body,
			"sessionId": sessionID,
			"url":       url,
			"namespace": namespace,
		},
	}

	return c.sseBus.PublishCount(event)
}

func buildSessionPath(sessionID string) string {
	return fmt.Sprintf("/sessions/%s", sessionID)
}

func getToolName(session *store.Session) string {
	state, ok := session.AgentState.(map[string]any)
	if !ok {
		return ""
	}

	requests, ok := state["requests"].(map[string]any)
	if !ok || len(requests) == 0 {
		return ""
	}

	// Sort keys for deterministic order
	ids := make([]string, 0, len(requests))
	for id := range requests {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	if reqMap, ok := requests[ids[0]].(map[string]any); ok {
		if tool, ok := reqMap["tool"].(string); ok {
			return tool
		}
	}

	return ""
}
