package sync

import "hub_go/internal/store"

func SessionEventData(session *store.Session) map[string]any {
	if session == nil {
		return map[string]any{}
	}
	return map[string]any{
		"id":                session.ID,
		"namespace":         session.Namespace,
		"seq":               session.Seq,
		"createdAt":         session.CreatedAt,
		"updatedAt":         session.UpdatedAt,
		"active":            session.Active,
		"activeAt":          session.ActiveAt,
		"metadata":          session.Metadata,
		"metadataVersion":   session.MetadataVersion,
		"agentState":        session.AgentState,
		"agentStateVersion": session.AgentStateVersion,
		"thinking":          session.Thinking,
		"thinkingAt":        session.ThinkingAt,
		"todos":             session.Todos,
		"permissionMode":    nullIfEmpty(session.PermissionMode),
		"modelMode":         nullIfEmpty(session.ModelMode),
	}
}

func MachineEventData(machine *store.Machine) map[string]any {
	if machine == nil {
		return map[string]any{}
	}
	return map[string]any{
		"id":                 machine.ID,
		"namespace":          machine.Namespace,
		"createdAt":          machine.CreatedAt,
		"updatedAt":          machine.UpdatedAt,
		"metadata":           machine.Metadata,
		"metadataVersion":    machine.MetadataVersion,
		"runnerState":        machine.RunnerState,
		"runnerStateVersion": machine.RunnerStateVersion,
		"active":             machine.Active,
		"activeAt":           machine.ActiveAt,
		"seq":                machine.Seq,
	}
}

func MessageEventData(msg store.Message) map[string]any {
	message := map[string]any{
		"id":        msg.ID,
		"seq":       msg.Seq,
		"content":   msg.Content,
		"createdAt": msg.CreatedAt,
	}
	if msg.LocalID != "" {
		message["localId"] = msg.LocalID
	} else {
		message["localId"] = nil
	}
	return message
}
