package notifications

import "hub_go/internal/store"

// GetSessionName returns a display name for the session
func GetSessionName(session *store.Session) string {
	if session == nil {
		return ""
	}
	if session.Metadata != nil {
		if name, ok := session.Metadata["name"].(string); ok && name != "" {
			return name
		}
		if summary, ok := session.Metadata["summary"].(map[string]any); ok {
			if text, ok := summary["text"].(string); ok && text != "" {
				return text
			}
		}
		if path, ok := session.Metadata["path"].(string); ok && path != "" {
			parts := splitPath(path)
			if len(parts) > 0 {
				return parts[len(parts)-1]
			}
		}
	}
	if len(session.ID) >= 8 {
		return session.ID[:8]
	}
	return session.ID
}

// GetAgentName returns the agent display name based on session flavor
func GetAgentName(session *store.Session) string {
	if session == nil || session.Metadata == nil {
		return "Agent"
	}
	flavor, ok := session.Metadata["flavor"].(string)
	if !ok {
		return "Agent"
	}
	switch flavor {
	case "claude":
		return "Claude"
	case "codex":
		return "Codex"
	case "gemini":
		return "Gemini"
	case "opencode":
		return "OpenCode"
	default:
		return "Agent"
	}
}

func splitPath(path string) []string {
	var parts []string
	current := ""
	for _, c := range path {
		if c == '/' {
			if current != "" {
				parts = append(parts, current)
				current = ""
			}
		} else {
			current += string(c)
		}
	}
	if current != "" {
		parts = append(parts, current)
	}
	return parts
}
