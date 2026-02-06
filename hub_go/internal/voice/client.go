package voice

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"
)

var (
	cacheMu      sync.Mutex
	agentIDCache = map[string]string{}
)

type agentListResponse struct {
	Agents []struct {
		AgentID string `json:"agent_id"`
		Name    string `json:"name"`
	} `json:"agents"`
}

type createAgentResponse struct {
	AgentID string `json:"agent_id"`
}

type tokenResponse struct {
	Token string `json:"token"`
}

func GetOrCreateAgentID(apiKey string) (string, error) {
	if apiKey == "" {
		return "", errors.New("missing api key")
	}
	cacheKey := hashKey(apiKey)
	cacheMu.Lock()
	if cached, ok := agentIDCache[cacheKey]; ok && cached != "" {
		cacheMu.Unlock()
		return cached, nil
	}
	cacheMu.Unlock()

	agentID, err := findAgentID(apiKey)
	if err == nil && agentID != "" {
		cacheMu.Lock()
		agentIDCache[cacheKey] = agentID
		cacheMu.Unlock()
		return agentID, nil
	}

	agentID, err = createAgentID(apiKey)
	if err != nil {
		return "", err
	}

	cacheMu.Lock()
	agentIDCache[cacheKey] = agentID
	cacheMu.Unlock()
	return agentID, nil
}

func FetchConversationToken(apiKey string, agentID string) (string, error) {
	if apiKey == "" || agentID == "" {
		return "", errors.New("missing api key or agent id")
	}
	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequest(
		http.MethodGet,
		ElevenLabsAPIBase+"/convai/conversation/token?agent_id="+agentID,
		nil,
	)
	if err != nil {
		return "", err
	}
	req.Header.Set("xi-api-key", apiKey)
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", errors.New("ElevenLabs API error: " + resp.Status)
	}

	var payload tokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", err
	}
	if payload.Token == "" {
		return "", errors.New("No token in ElevenLabs response")
	}
	return payload.Token, nil
}

func findAgentID(apiKey string) (string, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequest(http.MethodGet, ElevenLabsAPIBase+"/convai/agents", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("xi-api-key", apiKey)
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", errors.New("ElevenLabs API error: " + resp.Status)
	}
	var payload agentListResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", err
	}
	for _, agent := range payload.Agents {
		if agent.Name == VoiceAgentName && agent.AgentID != "" {
			return agent.AgentID, nil
		}
	}
	return "", errors.New("agent not found")
}

func createAgentID(apiKey string) (string, error) {
	config := BuildAgentConfig()
	raw, err := json.Marshal(config)
	if err != nil {
		return "", err
	}
	client := &http.Client{Timeout: 20 * time.Second}
	req, err := http.NewRequest(http.MethodPost, ElevenLabsAPIBase+"/convai/agents/create", bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("xi-api-key", apiKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", errors.New("ElevenLabs API error: " + resp.Status)
	}
	var payload createAgentResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", err
	}
	if payload.AgentID == "" {
		return "", errors.New("No agent_id in ElevenLabs response")
	}
	return payload.AgentID, nil
}

func hashKey(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}
