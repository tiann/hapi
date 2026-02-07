package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"hub_go/internal/notifications"
	"hub_go/internal/store"
	syncengine "hub_go/internal/sync"
)

// Bot represents the Telegram bot for HAPI
type Bot struct {
	token       string
	publicURL   string
	store       *store.Store
	engine      *syncengine.Engine
	httpClient  *http.Client
	isRunning   bool
	stopCh      chan struct{}
	mu          sync.Mutex
	updatesCh   chan Update
	lastUpdate  int64
	unsubscribe func()
}

// BotConfig contains the configuration for the bot
type BotConfig struct {
	Token     string
	PublicURL string
	Store     *store.Store
	Engine    *syncengine.Engine
}

// Update represents a Telegram update
type Update struct {
	UpdateID      int64          `json:"update_id"`
	Message       *Message       `json:"message,omitempty"`
	CallbackQuery *CallbackQuery `json:"callback_query,omitempty"`
}

// Message represents a Telegram message
type Message struct {
	MessageID int64  `json:"message_id"`
	From      *User  `json:"from,omitempty"`
	Chat      *Chat  `json:"chat"`
	Text      string `json:"text,omitempty"`
}

// Chat represents a Telegram chat
type Chat struct {
	ID   int64  `json:"id"`
	Type string `json:"type"`
}

// CallbackQuery represents a callback query from inline keyboard
type CallbackQuery struct {
	ID      string   `json:"id"`
	From    *User    `json:"from"`
	Message *Message `json:"message,omitempty"`
	Data    string   `json:"data,omitempty"`
}

// InlineKeyboardMarkup represents an inline keyboard
type InlineKeyboardMarkup struct {
	InlineKeyboard [][]InlineKeyboardButton `json:"inline_keyboard"`
}

// InlineKeyboardButton represents a button in an inline keyboard
type InlineKeyboardButton struct {
	Text         string      `json:"text"`
	CallbackData string      `json:"callback_data,omitempty"`
	WebApp       *WebAppInfo `json:"web_app,omitempty"`
}

// WebAppInfo represents a Web App info
type WebAppInfo struct {
	URL string `json:"url"`
}

// NewBot creates a new Telegram bot
func NewBot(config BotConfig) *Bot {
	if config.Token == "" {
		return nil
	}
	return &Bot{
		token:      config.Token,
		publicURL:  config.PublicURL,
		store:      config.Store,
		engine:     config.Engine,
		httpClient: &http.Client{Timeout: 60 * time.Second},
		stopCh:     make(chan struct{}),
		updatesCh:  make(chan Update, 100),
	}
}

// SetEngine sets the sync engine reference
func (b *Bot) SetEngine(engine *syncengine.Engine) {
	if b == nil {
		return
	}
	b.mu.Lock()
	b.engine = engine
	b.mu.Unlock()
}

// Start starts the bot polling
func (b *Bot) Start(ctx context.Context) error {
	if b == nil {
		return nil
	}

	b.mu.Lock()
	if b.isRunning {
		b.mu.Unlock()
		return nil
	}
	b.isRunning = true
	b.stopCh = make(chan struct{})
	b.mu.Unlock()

	log.Println("[TelegramBot] Starting bot...")

	// Start the update handler
	go b.handleUpdates()

	// Start polling
	go b.pollUpdates(ctx)

	<-ctx.Done()
	return b.Stop()
}

// Stop stops the bot
func (b *Bot) Stop() error {
	if b == nil {
		return nil
	}

	b.mu.Lock()
	if !b.isRunning {
		b.mu.Unlock()
		return nil
	}
	b.isRunning = false
	close(b.stopCh)
	if b.unsubscribe != nil {
		b.unsubscribe()
		b.unsubscribe = nil
	}
	b.mu.Unlock()

	log.Println("[TelegramBot] Bot stopped")
	return nil
}

func (b *Bot) pollUpdates(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-b.stopCh:
			return
		default:
			updates, err := b.getUpdates(b.lastUpdate+1, 30)
			if err != nil {
				log.Printf("[TelegramBot] Error getting updates: %v", err)
				time.Sleep(5 * time.Second)
				continue
			}

			for _, update := range updates {
				if update.UpdateID > b.lastUpdate {
					b.lastUpdate = update.UpdateID
				}
				select {
				case b.updatesCh <- update:
				default:
					log.Println("[TelegramBot] Update channel full, dropping update")
				}
			}
		}
	}
}

func (b *Bot) handleUpdates() {
	for {
		select {
		case <-b.stopCh:
			return
		case update := <-b.updatesCh:
			b.processUpdate(update)
		}
	}
}

func (b *Bot) processUpdate(update Update) {
	if update.Message != nil && update.Message.Text != "" {
		b.handleCommand(update.Message)
	}
	if update.CallbackQuery != nil {
		b.handleCallbackQuery(update.CallbackQuery)
	}
}

func (b *Bot) handleCommand(msg *Message) {
	text := strings.TrimSpace(msg.Text)
	if !strings.HasPrefix(text, "/") {
		return
	}

	parts := strings.SplitN(text, " ", 2)
	cmd := strings.ToLower(parts[0])

	switch cmd {
	case "/start":
		keyboard := InlineKeyboardMarkup{
			InlineKeyboard: [][]InlineKeyboardButton{
				{{Text: "Open App", WebApp: &WebAppInfo{URL: b.publicURL}}},
			},
		}
		b.sendMessage(msg.Chat.ID, "Welcome to HAPI Bot!\n\nUse the Mini App for full session management.", &keyboard)

	case "/app":
		keyboard := InlineKeyboardMarkup{
			InlineKeyboard: [][]InlineKeyboardButton{
				{{Text: "Open App", WebApp: &WebAppInfo{URL: b.publicURL}}},
			},
		}
		b.sendMessage(msg.Chat.ID, "Open HAPI Mini App:", &keyboard)
	}
}

func (b *Bot) handleCallbackQuery(query *CallbackQuery) {
	if b.engine == nil {
		b.answerCallbackQuery(query.ID, "Not connected")
		return
	}

	namespace := b.getNamespaceForChatID(query.From.ID)
	if namespace == "" {
		b.answerCallbackQuery(query.ID, "Telegram account is not bound")
		return
	}

	parsed := parseCallbackData(query.Data)
	sessions := b.engine.GetSessionsByNamespace(namespace)

	switch parsed.Action {
	case ActionApprove:
		session := findSessionByPrefix(sessions, parsed.SessionPrefix)
		if session == nil {
			b.answerCallbackQuery(query.ID, "Session not found")
			return
		}
		if !session.Active {
			b.answerCallbackQuery(query.ID, "Session is inactive")
			return
		}

		requestID := findRequestByPrefix(session, parsed.Extra)
		if requestID == "" {
			b.answerCallbackQuery(query.ID, "Request not found or already processed")
			return
		}

		// Approve permission via engine (you'll need to implement this method)
		if err := b.approvePermission(namespace, session.ID, requestID); err != nil {
			b.answerCallbackQuery(query.ID, "Failed to approve")
			return
		}

		b.answerCallbackQuery(query.ID, "Approved!")
		if query.Message != nil {
			b.editMessageText(query.Message.Chat.ID, query.Message.MessageID, "Permission approved.", nil)
		}

	case ActionDeny:
		session := findSessionByPrefix(sessions, parsed.SessionPrefix)
		if session == nil {
			b.answerCallbackQuery(query.ID, "Session not found")
			return
		}
		if !session.Active {
			b.answerCallbackQuery(query.ID, "Session is inactive")
			return
		}

		requestID := findRequestByPrefix(session, parsed.Extra)
		if requestID == "" {
			b.answerCallbackQuery(query.ID, "Request not found or already processed")
			return
		}

		if err := b.denyPermission(namespace, session.ID, requestID); err != nil {
			b.answerCallbackQuery(query.ID, "Failed to deny")
			return
		}

		b.answerCallbackQuery(query.ID, "Denied")
		if query.Message != nil {
			b.editMessageText(query.Message.Chat.ID, query.Message.MessageID, "Permission denied.", nil)
		}

	default:
		b.answerCallbackQuery(query.ID, "Unknown action")
	}
}

// SendReady sends a ready notification
func (b *Bot) SendReady(session *store.Session) error {
	if b == nil || session == nil || !session.Active {
		return nil
	}

	agentName := notifications.GetAgentName(session)
	appURL := buildMiniAppDeepLink(b.publicURL, "session_"+session.ID)

	keyboard := InlineKeyboardMarkup{
		InlineKeyboard: [][]InlineKeyboardButton{
			{{Text: "Open Session", WebApp: &WebAppInfo{URL: appURL}}},
		},
	}

	chatIDs := b.getBoundChatIDs(session.Namespace)
	if len(chatIDs) == 0 {
		return nil
	}

	text := fmt.Sprintf("It's ready!\n\n%s is waiting for your command", agentName)
	for _, chatID := range chatIDs {
		if err := b.sendMessage(chatID, text, &keyboard); err != nil {
			log.Printf("[TelegramBot] Failed to send ready notification to chat %d: %v", chatID, err)
		}
	}

	return nil
}

// SendPermissionRequest sends a permission request notification
func (b *Bot) SendPermissionRequest(session *store.Session) error {
	if b == nil || session == nil || !session.Active {
		return nil
	}

	text := formatSessionNotification(session)
	keyboard := createNotificationKeyboard(session, b.publicURL)

	chatIDs := b.getBoundChatIDs(session.Namespace)
	if len(chatIDs) == 0 {
		return nil
	}

	for _, chatID := range chatIDs {
		if err := b.sendMessage(chatID, text, keyboard); err != nil {
			log.Printf("[TelegramBot] Failed to send notification to chat %d: %v", chatID, err)
		}
	}

	return nil
}

func (b *Bot) getBoundChatIDs(namespace string) []int64 {
	if b.store == nil {
		return nil
	}

	users := b.store.GetUsersByPlatformAndNamespace("telegram", namespace)
	ids := make([]int64, 0, len(users))
	seen := make(map[int64]bool)

	for _, user := range users {
		chatID, err := strconv.ParseInt(user.PlatformUserID, 10, 64)
		if err != nil {
			continue
		}
		if !seen[chatID] {
			seen[chatID] = true
			ids = append(ids, chatID)
		}
	}

	return ids
}

func (b *Bot) getNamespaceForChatID(chatID int64) string {
	if b.store == nil {
		return ""
	}

	user, err := b.store.GetUser("telegram", strconv.FormatInt(chatID, 10))
	if err != nil || user == nil {
		return ""
	}
	return user.Namespace
}

// API methods

func (b *Bot) apiURL(method string) string {
	return fmt.Sprintf("https://api.telegram.org/bot%s/%s", b.token, method)
}

func (b *Bot) getUpdates(offset int64, timeout int) ([]Update, error) {
	params := url.Values{}
	params.Set("offset", strconv.FormatInt(offset, 10))
	params.Set("timeout", strconv.Itoa(timeout))
	params.Set("allowed_updates", `["message","callback_query"]`)

	resp, err := b.httpClient.Get(b.apiURL("getUpdates") + "?" + params.Encode())
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		var apiErr struct {
			OK          bool   `json:"ok"`
			ErrorCode   int    `json:"error_code"`
			Description string `json:"description"`
		}
		if err := json.Unmarshal(body, &apiErr); err == nil && apiErr.Description != "" {
			return nil, fmt.Errorf("telegram API getUpdates error (%d): %s", apiErr.ErrorCode, apiErr.Description)
		}
		return nil, fmt.Errorf("telegram API getUpdates http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var result struct {
		OK          bool     `json:"ok"`
		Result      []Update `json:"result"`
		ErrorCode   int      `json:"error_code"`
		Description string   `json:"description"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	if !result.OK {
		errText := strings.TrimSpace(result.Description)
		if errText == "" {
			errText = strings.TrimSpace(string(body))
		}
		return nil, fmt.Errorf("telegram API getUpdates not ok (%d): %s", result.ErrorCode, errText)
	}

	return result.Result, nil
}

func (b *Bot) sendMessage(chatID int64, text string, keyboard *InlineKeyboardMarkup) error {
	payload := map[string]any{
		"chat_id": chatID,
		"text":    text,
	}
	if keyboard != nil {
		payload["reply_markup"] = keyboard
	}

	return b.apiCall("sendMessage", payload)
}

func (b *Bot) answerCallbackQuery(queryID string, text string) error {
	payload := map[string]any{
		"callback_query_id": queryID,
	}
	if text != "" {
		payload["text"] = text
	}
	return b.apiCall("answerCallbackQuery", payload)
}

func (b *Bot) editMessageText(chatID int64, messageID int64, text string, keyboard *InlineKeyboardMarkup) error {
	payload := map[string]any{
		"chat_id":    chatID,
		"message_id": messageID,
		"text":       text,
	}
	if keyboard != nil {
		payload["reply_markup"] = keyboard
	}
	return b.apiCall("editMessageText", payload)
}

func (b *Bot) apiCall(method string, payload map[string]any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	resp, err := b.httpClient.Post(b.apiURL(method), "application/json", bytes.NewReader(data))
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("telegram API error: %s", string(body))
	}

	return nil
}

func (b *Bot) approvePermission(namespace, sessionID, requestID string) error {
	if b == nil || b.engine == nil || b.engine.RpcGateway() == nil {
		return errors.New("not connected")
	}
	if sessionID == "" {
		return errors.New("missing sessionID")
	}
	if requestID == "" {
		return errors.New("missing requestID")
	}
	_, err := b.callSessionRPC(sessionID, "permission", map[string]any{
		"id":       requestID,
		"approved": true,
	})
	return err
}

func (b *Bot) denyPermission(namespace, sessionID, requestID string) error {
	if b == nil || b.engine == nil || b.engine.RpcGateway() == nil {
		return errors.New("not connected")
	}
	if sessionID == "" {
		return errors.New("missing sessionID")
	}
	if requestID == "" {
		return errors.New("missing requestID")
	}
	_, err := b.callSessionRPC(sessionID, "permission", map[string]any{
		"id":       requestID,
		"approved": false,
	})
	return err
}

func (b *Bot) callSessionRPC(sessionID string, method string, params map[string]any) (any, error) {
	if b == nil || b.engine == nil || b.engine.RpcGateway() == nil {
		return nil, errors.New("not connected")
	}
	methodName := sessionID + ":" + method
	if params == nil {
		params = map[string]any{}
	}
	paramsRaw, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	raw, err := b.engine.RpcGateway().Call(methodName, map[string]any{
		"method": methodName,
		"params": string(paramsRaw),
	}, 30*time.Second)
	if err != nil {
		return nil, err
	}
	return decodeRPCPayload(raw)
}

func decodeRPCPayload(raw json.RawMessage) (any, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, errors.New("empty response")
	}
	var str string
	if err := json.Unmarshal(raw, &str); err == nil {
		if str == "" {
			return str, nil
		}
		var decoded any
		if err := json.Unmarshal([]byte(str), &decoded); err == nil {
			return decoded, nil
		}
		return str, nil
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err == nil {
		return decoded, nil
	}
	return nil, errors.New("invalid response")
}

// Callback data handling

const (
	ActionApprove = "ap"
	ActionDeny    = "dn"
)

const maxCallbackData = 64

type CallbackData struct {
	Action        string
	SessionPrefix string
	Extra         string
}

func createCallbackData(action, sessionID, extra string) string {
	sessionPrefix := sessionID
	if len(sessionPrefix) > 8 {
		sessionPrefix = sessionPrefix[:8]
	}

	data := action + ":" + sessionPrefix
	if extra != "" {
		remaining := maxCallbackData - len(data) - 1
		if remaining > 0 {
			if len(extra) > remaining {
				extra = extra[:remaining]
			}
			data += ":" + extra
		}
	}

	if len(data) > maxCallbackData {
		data = data[:maxCallbackData]
	}
	return data
}

func parseCallbackData(data string) CallbackData {
	parts := strings.SplitN(data, ":", 3)
	result := CallbackData{}
	if len(parts) > 0 {
		result.Action = parts[0]
	}
	if len(parts) > 1 {
		result.SessionPrefix = parts[1]
	}
	if len(parts) > 2 {
		result.Extra = parts[2]
	}
	return result
}

func findSessionByPrefix(sessions []store.Session, prefix string) *store.Session {
	for i := range sessions {
		if strings.HasPrefix(sessions[i].ID, prefix) {
			return &sessions[i]
		}
	}
	return nil
}

func findRequestByPrefix(session *store.Session, prefix string) string {
	if session == nil || prefix == "" {
		return ""
	}

	state, ok := session.AgentState.(map[string]any)
	if !ok {
		return ""
	}

	requests, ok := state["requests"].(map[string]any)
	if !ok {
		return ""
	}

	match := ""
	for reqID := range requests {
		if strings.HasPrefix(reqID, prefix) {
			if match != "" {
				return ""
			}
			match = reqID
		}
	}
	return match
}

func getFirstRequest(session *store.Session) (string, map[string]any) {
	if session == nil {
		return "", nil
	}

	state, ok := session.AgentState.(map[string]any)
	if !ok {
		return "", nil
	}

	requests, ok := state["requests"].(map[string]any)
	if !ok || len(requests) == 0 {
		return "", nil
	}

	ids := make([]string, 0, len(requests))
	for id := range requests {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	requestID := ids[0]
	request, _ := requests[requestID].(map[string]any)
	return requestID, request
}

// Notification formatting

func formatSessionNotification(session *store.Session) string {
	name := notifications.GetSessionName(session)
	lines := []string{"Permission Request", "", "Session: " + name}
	_, req := getFirstRequest(session)
	if req != nil {
		if tool, ok := req["tool"].(string); ok {
			lines = append(lines, "Tool: "+tool)
		}
		args := formatToolArgumentsDetailed(req)
		if args != "" {
			lines = append(lines, args)
		}
	}

	return strings.Join(lines, "\n")
}

func formatToolArgumentsDetailed(req map[string]any) string {
	tool, _ := req["tool"].(string)
	args, ok := req["arguments"].(map[string]any)
	if !ok {
		return ""
	}

	const maxLen = 150

	switch tool {
	case "Edit":
		file := getStringArg(args, "file_path", "path")
		oldStr := truncate(getStringArg(args, "old_string"), 50)
		newStr := truncate(getStringArg(args, "new_string"), 50)
		result := "File: " + truncate(file, maxLen)
		if oldStr != "" {
			result += "\nOld: \"" + oldStr + "\""
		}
		if newStr != "" {
			result += "\nNew: \"" + newStr + "\""
		}
		return result

	case "Write":
		file := getStringArg(args, "file_path", "path")
		content := getStringArg(args, "content")
		result := "File: " + truncate(file, maxLen)
		if content != "" {
			result += fmt.Sprintf(" (%d chars)", len(content))
		}
		return result

	case "Read":
		file := getStringArg(args, "file_path", "path")
		return "File: " + truncate(file, maxLen)

	case "Bash":
		cmd := getStringArg(args, "command")
		return "Command: " + truncate(cmd, maxLen)

	case "Task":
		desc := getStringArg(args, "description", "prompt")
		return "Task: " + truncate(desc, maxLen)

	case "Grep", "Glob":
		pattern := getStringArg(args, "pattern")
		path := getStringArg(args, "path")
		result := "Pattern: " + pattern
		if path != "" {
			result += "\nPath: " + truncate(path, 80)
		}
		return result

	case "WebFetch":
		urlStr := getStringArg(args, "url")
		return "URL: " + truncate(urlStr, maxLen)

	case "TodoWrite":
		if todos, ok := args["todos"].([]any); ok {
			return fmt.Sprintf("Updating %d todo items", len(todos))
		}
		return ""

	default:
		data, err := json.Marshal(args)
		if err != nil || len(data) <= 10 {
			return ""
		}
		return "Args: " + truncate(string(data), maxLen)
	}
}

func getStringArg(args map[string]any, keys ...string) string {
	for _, key := range keys {
		if val, ok := args[key].(string); ok && val != "" {
			return val
		}
	}
	return ""
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen-3] + "..."
}

func createNotificationKeyboard(session *store.Session, publicURL string) *InlineKeyboardMarkup {
	keyboard := &InlineKeyboardMarkup{
		InlineKeyboard: [][]InlineKeyboardButton{},
	}

	requestID, _ := getFirstRequest(session)
	hasRequests := requestID != ""

	if session.Active && hasRequests {
		keyboard.InlineKeyboard = append(keyboard.InlineKeyboard, []InlineKeyboardButton{
			{Text: "Allow", CallbackData: createCallbackData(ActionApprove, session.ID, requestID)},
			{Text: "Deny", CallbackData: createCallbackData(ActionDeny, session.ID, requestID)},
		})

		appURL := buildMiniAppDeepLink(publicURL, "session_"+session.ID)
		keyboard.InlineKeyboard = append(keyboard.InlineKeyboard, []InlineKeyboardButton{
			{Text: "Details", WebApp: &WebAppInfo{URL: appURL}},
		})
	} else {
		appURL := buildMiniAppDeepLink(publicURL, "session_"+session.ID)
		keyboard.InlineKeyboard = append(keyboard.InlineKeyboard, []InlineKeyboardButton{
			{Text: "Open Session", WebApp: &WebAppInfo{URL: appURL}},
		})
	}

	return keyboard
}

func buildMiniAppDeepLink(baseURL, startParam string) string {
	u, err := url.Parse(baseURL)
	if err != nil {
		sep := "?"
		if strings.Contains(baseURL, "?") {
			sep = "&"
		}
		return baseURL + sep + "startapp=" + url.QueryEscape(startParam)
	}

	q := u.Query()
	q.Set("startapp", startParam)
	u.RawQuery = q.Encode()
	return u.String()
}
