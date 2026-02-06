package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"hub_go/internal/config"
	"hub_go/internal/http"
	"hub_go/internal/socketio"
	"hub_go/internal/sse"
	"hub_go/internal/store"
	syncengine "hub_go/internal/sync"
)

type Server struct {
	httpServer *http.Server
	store      *store.Store
	sseBus     *sse.Bus
	socketIO   *socketio.Server
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

	address := fmt.Sprintf("%s:%d", cfg.ListenHost, cfg.ListenPort)

	srv := &http.Server{
		Addr:              address,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	return &Server{httpServer: srv, store: storeInstance, sseBus: bus, socketIO: socketServer}, nil
}

func (s *Server) Start() error {
	return s.httpServer.ListenAndServe()
}

func (s *Server) Shutdown(ctx context.Context) error {
	if s.store != nil {
		_ = s.store.Close()
	}
	return s.httpServer.Shutdown(ctx)
}
