package config

import (
	"crypto/rand"
	"encoding/base64"
	"log"
	"strings"

	"hub_go/internal/auth"
)

type CliApiTokenResult struct {
	Token  string
	Source string
	IsNew  bool
}

func LoadOrCreateCliApiToken(settingsFile string) (*CliApiTokenResult, error) {
	if env := strings.TrimSpace(getenvDefault("CLI_API_TOKEN", "")); env != "" {
		normalized := normalizeCliApiToken(env, "env")
		if isWeakToken(normalized) {
			log.Printf("[WARN] CLI_API_TOKEN appears to be weak. Consider using a stronger secret.")
		}

		settings, err := readSettings(settingsFile)
		if err != nil {
			return nil, err
		}
		if settings.CliApiToken == nil {
			settings.CliApiToken = &normalized
			if err := writeSettings(settingsFile, settings); err != nil {
				return nil, err
			}
		}

		return &CliApiTokenResult{Token: normalized, Source: "env", IsNew: false}, nil
	}

	settings, err := readSettings(settingsFile)
	if err != nil {
		return nil, err
	}

	if settings.CliApiToken != nil && *settings.CliApiToken != "" {
		normalized := normalizeCliApiToken(*settings.CliApiToken, "file")
		if normalized != *settings.CliApiToken {
			settings.CliApiToken = &normalized
			if err := writeSettings(settingsFile, settings); err != nil {
				return nil, err
			}
		}
		return &CliApiTokenResult{Token: normalized, Source: "file", IsNew: false}, nil
	}

	token, err := generateSecureToken()
	if err != nil {
		return nil, err
	}

	settings.CliApiToken = &token
	if err := writeSettings(settingsFile, settings); err != nil {
		return nil, err
	}

	return &CliApiTokenResult{Token: token, Source: "generated", IsNew: true}, nil
}

func generateSecureToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func isWeakToken(token string) bool {
	if len(token) < 16 {
		return true
	}

	weakPatterns := []string{"abc", "123", "password", "secret", "token"}
	lower := strings.ToLower(token)
	for _, pattern := range weakPatterns {
		if strings.HasPrefix(lower, pattern) {
			return true
		}
	}

	allSame := true
	for i := 1; i < len(token); i++ {
		if token[i] != token[0] {
			allSame = false
			break
		}
	}
	if allSame {
		return true
	}

	digitsOnly := true
	for i := 0; i < len(token); i++ {
		if token[i] < '0' || token[i] > '9' {
			digitsOnly = false
			break
		}
	}
	return digitsOnly
}

func normalizeCliApiToken(raw string, source string) string {
	parsed := auth.ParseAccessToken(raw)
	if parsed == nil {
		if strings.Contains(raw, ":") {
			log.Printf("[WARN] CLI_API_TOKEN from %s contains ':' but is not a valid token. Server expects a base token without namespace.", source)
		}
		return raw
	}

	if !strings.Contains(raw, ":") {
		return raw
	}

	log.Printf("[WARN] CLI_API_TOKEN from %s includes namespace suffix '%s'. Stripping suffix.", source, parsed.Namespace)
	return parsed.BaseToken
}
