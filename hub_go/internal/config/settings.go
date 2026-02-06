package config

import (
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type serverSettingsFile struct {
	TelegramBotToken     *string    `json:"telegramBotToken,omitempty"`
	TelegramNotification *bool      `json:"telegramNotification,omitempty"`
	ListenHost           *string    `json:"listenHost,omitempty"`
	ListenPort           *int       `json:"listenPort,omitempty"`
	PublicURL            *string    `json:"publicUrl,omitempty"`
	CorsOrigins          []string   `json:"corsOrigins,omitempty"`
	CliApiToken          *string    `json:"cliApiToken,omitempty"`
	VapidKeys            *VapidKeys `json:"vapidKeys,omitempty"`

	WebappHost *string `json:"webappHost,omitempty"`
	WebappPort *int    `json:"webappPort,omitempty"`
	WebappURL  *string `json:"webappUrl,omitempty"`
}

type ServerSettings struct {
	TelegramBotToken     *string
	TelegramNotification bool
	ListenHost           string
	ListenPort           int
	PublicURL            string
	CorsOrigins          []string
}

func LoadServerSettings(settingsFile string) (*ServerSettings, error) {
	rawSettings, err := readSettings(settingsFile)
	if err != nil {
		return nil, err
	}

	needsSave := false

	telegramBotToken := rawSettings.TelegramBotToken
	if env := os.Getenv("TELEGRAM_BOT_TOKEN"); env != "" {
		telegramBotToken = &env
		if rawSettings.TelegramBotToken == nil {
			rawSettings.TelegramBotToken = &env
			needsSave = true
		}
	}

	telegramNotification := true
	if env := os.Getenv("TELEGRAM_NOTIFICATION"); env != "" {
		telegramNotification = strings.ToLower(env) == "true"
		if rawSettings.TelegramNotification == nil {
			rawSettings.TelegramNotification = &telegramNotification
			needsSave = true
		}
	} else if rawSettings.TelegramNotification != nil {
		telegramNotification = *rawSettings.TelegramNotification
	}

	listenHost := defaultListenHost
	if env := os.Getenv("HAPI_LISTEN_HOST"); env != "" {
		listenHost = env
		if rawSettings.ListenHost == nil {
			rawSettings.ListenHost = &env
			needsSave = true
		}
	} else if rawSettings.ListenHost != nil {
		listenHost = *rawSettings.ListenHost
	} else if rawSettings.WebappHost != nil {
		listenHost = *rawSettings.WebappHost
		rawSettings.ListenHost = rawSettings.WebappHost
		rawSettings.WebappHost = nil
		needsSave = true
	}

	listenPort := defaultListenPort
	if env := os.Getenv("HAPI_LISTEN_PORT"); env != "" {
		parsed, err := parsePortEnv("HAPI_LISTEN_PORT", defaultListenPort)
		if err != nil {
			return nil, err
		}
		listenPort = parsed
		if rawSettings.ListenPort == nil {
			rawSettings.ListenPort = &parsed
			needsSave = true
		}
	} else if rawSettings.ListenPort != nil {
		listenPort = *rawSettings.ListenPort
	} else if rawSettings.WebappPort != nil {
		listenPort = *rawSettings.WebappPort
		rawSettings.ListenPort = rawSettings.WebappPort
		rawSettings.WebappPort = nil
		needsSave = true
	}

	publicURL := "http://localhost:" + strconv.Itoa(listenPort)
	if env := os.Getenv("HAPI_PUBLIC_URL"); env != "" {
		publicURL = env
		if rawSettings.PublicURL == nil {
			rawSettings.PublicURL = &env
			needsSave = true
		}
	} else if rawSettings.PublicURL != nil {
		publicURL = *rawSettings.PublicURL
	} else if rawSettings.WebappURL != nil {
		publicURL = *rawSettings.WebappURL
		rawSettings.PublicURL = rawSettings.WebappURL
		rawSettings.WebappURL = nil
		needsSave = true
	}

	corsOrigins := []string{}
	if env := os.Getenv("CORS_ORIGINS"); env != "" {
		corsOrigins = parseCorsOrigins(env)
		if rawSettings.CorsOrigins == nil {
			rawSettings.CorsOrigins = corsOrigins
			needsSave = true
		}
	} else if rawSettings.CorsOrigins != nil {
		corsOrigins = rawSettings.CorsOrigins
	} else {
		corsOrigins = deriveCorsOrigins(publicURL)
	}

	if needsSave {
		if err := writeSettings(settingsFile, rawSettings); err != nil {
			return nil, err
		}
	}

	return &ServerSettings{
		TelegramBotToken:     telegramBotToken,
		TelegramNotification: telegramNotification,
		ListenHost:           listenHost,
		ListenPort:           listenPort,
		PublicURL:            publicURL,
		CorsOrigins:          corsOrigins,
	}, nil
}

func readSettings(path string) (*serverSettingsFile, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &serverSettingsFile{}, nil
		}
		return nil, err
	}

	var settings serverSettingsFile
	if err := json.Unmarshal(raw, &settings); err != nil {
		return nil, err
	}
	return &settings, nil
}

func writeSettings(path string, settings *serverSettingsFile) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}

	payload, err := json.MarshalIndent(settings, "", "    ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, payload, 0o600)
}

func parseCorsOrigins(raw string) []string {
	entries := strings.Split(raw, ",")
	origins := make([]string, 0, len(entries))
	for _, entry := range entries {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		if trimmed == "*" {
			return []string{"*"}
		}
		parsed, err := url.Parse(trimmed)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			origins = append(origins, trimmed)
			continue
		}
		origins = append(origins, parsed.Scheme+"://"+parsed.Host)
	}
	return origins
}

func deriveCorsOrigins(publicURL string) []string {
	parsed, err := url.Parse(publicURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return []string{}
	}
	return []string{parsed.Scheme + "://" + parsed.Host}
}
