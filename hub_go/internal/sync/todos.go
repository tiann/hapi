package sync

import "strings"

type TodoItem struct {
	Content  string
	Priority string
	Status   string
	ID       string
}

func ExtractTodoWriteTodosFromMessageContent(messageContent any) []map[string]any {
	record, ok := unwrapRoleWrappedRecordEnvelope(messageContent)
	if !ok {
		return nil
	}
	role, _ := record["role"].(string)
	if role != "agent" && role != "assistant" {
		return nil
	}
	content, ok := record["content"].(map[string]any)
	if !ok {
		return nil
	}
	contentType, _ := content["type"].(string)
	if contentType == "output" {
		if todos := extractTodosFromClaudeOutput(content); todos != nil {
			return todos
		}
	}
	if contentType == "codex" {
		if todos := extractTodosFromCodexMessage(content); todos != nil {
			return todos
		}
		if todos := extractTodosFromAcpMessage(content); todos != nil {
			return todos
		}
	}
	return nil
}

func unwrapRoleWrappedRecordEnvelope(value any) (map[string]any, bool) {
	if obj, ok := value.(map[string]any); ok {
		if isRoleWrappedRecord(obj) {
			return obj, true
		}
		if direct, ok := obj["message"].(map[string]any); ok && isRoleWrappedRecord(direct) {
			return direct, true
		}
		if data, ok := obj["data"].(map[string]any); ok {
			if msg, ok := data["message"].(map[string]any); ok && isRoleWrappedRecord(msg) {
				return msg, true
			}
		}
		if payload, ok := obj["payload"].(map[string]any); ok {
			if msg, ok := payload["message"].(map[string]any); ok && isRoleWrappedRecord(msg) {
				return msg, true
			}
		}
	}
	return nil, false
}

func isRoleWrappedRecord(obj map[string]any) bool {
	role, ok := obj["role"].(string)
	if !ok || role == "" {
		return false
	}
	_, ok = obj["content"]
	return ok
}

func extractTodosFromClaudeOutput(content map[string]any) []map[string]any {
	if content["type"] != "output" {
		return nil
	}
	data, ok := content["data"].(map[string]any)
	if !ok || data["type"] != "assistant" {
		return nil
	}
	message, ok := data["message"].(map[string]any)
	if !ok {
		return nil
	}
	blocks, ok := message["content"].([]any)
	if !ok {
		return nil
	}
	for _, block := range blocks {
		entry, ok := block.(map[string]any)
		if !ok {
			continue
		}
		if entry["type"] != "tool_use" {
			continue
		}
		name, _ := entry["name"].(string)
		if name != "TodoWrite" {
			continue
		}
		input, ok := entry["input"].(map[string]any)
		if !ok {
			continue
		}
		if todos := validateTodos(input["todos"]); todos != nil {
			return todos
		}
	}
	return nil
}

func extractTodosFromCodexMessage(content map[string]any) []map[string]any {
	if content["type"] != "codex" {
		return nil
	}
	data, ok := content["data"].(map[string]any)
	if !ok || data["type"] != "tool-call" {
		return nil
	}
	name, _ := data["name"].(string)
	if name != "TodoWrite" {
		return nil
	}
	input, ok := data["input"].(map[string]any)
	if !ok {
		return nil
	}
	return validateTodos(input["todos"])
}

func extractTodosFromAcpMessage(content map[string]any) []map[string]any {
	if content["type"] != "codex" {
		return nil
	}
	data, ok := content["data"].(map[string]any)
	if !ok || data["type"] != "plan" {
		return nil
	}
	entries, ok := data["entries"].([]any)
	if !ok {
		return nil
	}

	todos := make([]map[string]any, 0, len(entries))
	for index, entry := range entries {
		item, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		contentValue, _ := item["content"].(string)
		priorityValue, _ := item["priority"].(string)
		statusValue, _ := item["status"].(string)
		if contentValue == "" || !validPriority(priorityValue) || !validStatus(statusValue) {
			continue
		}
		idValue, _ := item["id"].(string)
		if idValue == "" {
			idValue = "plan-" + itoa(index+1)
		}
		todos = append(todos, map[string]any{
			"content":  contentValue,
			"priority": priorityValue,
			"status":   statusValue,
			"id":       idValue,
		})
	}
	if len(todos) == 0 {
		return nil
	}
	return todos
}

func validateTodos(candidate any) []map[string]any {
	items, ok := candidate.([]any)
	if !ok || len(items) == 0 {
		return nil
	}
	todos := make([]map[string]any, 0, len(items))
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		contentValue, _ := item["content"].(string)
		priorityValue, _ := item["priority"].(string)
		statusValue, _ := item["status"].(string)
		idValue, _ := item["id"].(string)
		if contentValue == "" || !validPriority(priorityValue) || !validStatus(statusValue) {
			continue
		}
		if idValue == "" {
			idValue = strings.ReplaceAll(contentValue, " ", "-")
		}
		todos = append(todos, map[string]any{
			"content":  contentValue,
			"priority": priorityValue,
			"status":   statusValue,
			"id":       idValue,
		})
	}
	if len(todos) == 0 {
		return nil
	}
	return todos
}

func validPriority(value string) bool {
	return value == "high" || value == "medium" || value == "low"
}

func validStatus(value string) bool {
	return value == "pending" || value == "in_progress" || value == "completed"
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	buf := [20]byte{}
	i := len(buf)
	n := value
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
