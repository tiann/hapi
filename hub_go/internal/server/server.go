package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"hub_go/internal/assets"
	"hub_go/internal/config"
	httpserver "hub_go/internal/http"
	"hub_go/internal/notifications"
	"hub_go/internal/push"
	"hub_go/internal/socketio"
	"hub_go/internal/sse"
	"hub_go/internal/store"
	syncengine "hub_go/internal/sync"
	"hub_go/internal/telegram"
	"hub_go/internal/tunnel"
)

type Server struct {
	httpServer      *http.Server
	store           *store.Store
	sseBus          *sse.Bus
	socketIO        *socketio.Server
	telegramBot     *telegram.Bot
	tunnelManager   *tunnel.Manager
	notificationHub *notifications.NotificationHub
}

func New(cfg *config.Config, jwtSecret []byte) (*Server, error) {
	storeInstance, err := store.Open(cfg.DBPath)
	if err != nil {
		return nil, err
	}

	bus := sse.NewBus()
	visibility := sse.NewVisibilityTracker()
	vapidKeys, err := config.LoadOrCreateVapidKeys(cfg.SettingsFile)
	if err != nil {
		return nil, err
	}
	var engine *syncengine.Engine
	var socketServer *socketio.Server
	socketServer = socketio.NewServer(socketio.Dependencies{
		Store:       storeInstance,
		SSE:         bus,
		CliApiToken: cfg.CliApiToken,
		JWTSecret:   jwtSecret,
		Engine:      nil,
		Send: func(namespace string, event string, payload any) {
			if socketServer != nil {
				socketServer.Send(namespace, event, payload)
			}
		},
	})

	router := httpserver.NewRouter()
	engineDeps := syncengine.EngineDeps{
		Store:  storeInstance,
		SSEBus: bus,
		RpcSender: func(method string, payload any) (<-chan json.RawMessage, error) {
			_, ch, err := socketServer.SendRpc(method, payload)
			return ch, err
		},
	}
	engine = syncengine.NewEngine(engineDeps)
	socketServer.SetEngine(engine)

	// Push Service
	vapidSubject := os.Getenv("VAPID_SUBJECT")
	if vapidSubject == "" {
		vapidSubject = "mailto:admin@hapi.run"
	}
	pushService, err := push.NewService(vapidKeys, vapidSubject, storeInstance)
	if err != nil {
		log.Printf("[Server] Push service init failed: %v (push notifications disabled)", err)
	}
	var pushChannel *push.NotificationChannel
	if pushService != nil {
		pushChannel = push.NewNotificationChannel(pushService, bus, visibility)
	}

	// Telegram Bot
	var telegramToken string
	if cfg.TelegramBotToken != nil {
		telegramToken = *cfg.TelegramBotToken
	}
	telegramBot := telegram.NewBot(telegram.BotConfig{
		Token:     telegramToken,
		PublicURL: cfg.PublicURL,
		Store:     storeInstance,
		Engine:    engine,
	})

	// Notification Hub
	var channels []notifications.NotificationChannel
	if telegramBot != nil && cfg.TelegramNotification {
		channels = append(channels, telegramBot)
	}
	if pushChannel != nil {
		channels = append(channels, pushChannel)
	}
	notificationHub := notifications.NewNotificationHub(engine, channels, nil)

	// Tunnel Manager
	tunnelManager := tunnel.NewManager(tunnel.Config{
		LocalPort: cfg.ListenPort,
		Enabled:   cfg.RelayEnabled,
		APIDomain: cfg.RelayAPIDomain,
		AuthKey:   cfg.RelayAuthKey,
		UseRelay:  cfg.RelayUseRelay,
	})

	httpserver.RegisterRoutes(router, httpserver.AuthDependencies{
		JWTSecret:      jwtSecret,
		CliApiToken:    cfg.CliApiToken,
		TelegramToken:  cfg.TelegramBotToken,
		DataDir:        cfg.DataDir,
		Store:          storeInstance,
		Engine:         engine,
		SSEBus:         bus,
		Visibility:     visibility,
		SocketIO:       socketServer,
		CorsOrigins:    cfg.CorsOrigins,
		VapidPublicKey: vapidKeys.PublicKey,
	})

	if assets.HasEmbeddedAssets() {
		router.SetFallback(assets.Handler())
		log.Println("[Server] Serving embedded web assets")
	}

	address := fmt.Sprintf("%s:%d", cfg.ListenHost, cfg.ListenPort)

	srv := &http.Server{
		Addr:              address,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	return &Server{
		httpServer:      srv,
		store:           storeInstance,
		sseBus:          bus,
		socketIO:        socketServer,
		telegramBot:     telegramBot,
		tunnelManager:   tunnelManager,
		notificationHub: notificationHub,
	}, nil
}

func (s *Server) Start() error {
	// Start Telegram bot (nil-safe, noop if bot is nil)
	if s.telegramBot != nil {
		go func() {
			if err := s.telegramBot.Start(context.Background()); err != nil {
				log.Printf("[Server] Telegram bot error: %v", err)
			}
		}()
	}

	// Start tunnel after HTTP server is ready (async)
	if s.tunnelManager != nil && s.tunnelManager.Enabled() {
		go func() {
			tunnelURL, err := s.tunnelManager.Start()
			if err != nil {
				log.Printf("[Server] Tunnel start failed: %v (continuing without tunnel)", err)
				return
			}
			if tunnelURL != "" {
				go func() {
					if tunnel.WaitForTLSReady(tunnelURL, s.tunnelManager) {
						log.Printf("[Server] Tunnel ready: %s", tunnelURL)
					}
				}()
			}
		}()
	}

	return s.httpServer.ListenAndServe()
}

func (s *Server) Shutdown(ctx context.Context) error {
	if s.notificationHub != nil {
		s.notificationHub.Stop()
	}
	if s.telegramBot != nil {
		_ = s.telegramBot.Stop()
	}
	if s.tunnelManager != nil {
		_ = s.tunnelManager.Stop()
	}
	if s.socketIO != nil {
		s.socketIO.Stop()
	}
	if s.store != nil {
		_ = s.store.Close()
	}
	return s.httpServer.Shutdown(ctx)
}
