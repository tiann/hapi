package httpserver

import (
	"net/http"
	"strings"
)

type CORSConfig struct {
	Origins []string
}

func CORSMiddleware(config CORSConfig) Middleware {
	allowed := config.Origins
	allowAll := false
	for _, origin := range allowed {
		if origin == "*" {
			allowAll = true
			break
		}
	}

	return func(next HandlerFunc) HandlerFunc {
		return func(w http.ResponseWriter, req *http.Request, params Params) {
			origin := req.Header.Get("Origin")
			if origin != "" {
				if allowAll || containsOrigin(allowed, origin) {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Vary", "Origin")
					w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
					w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type")
				}
			}

			if req.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next(w, req, params)
		}
	}
}

func containsOrigin(origins []string, value string) bool {
	for _, origin := range origins {
		if strings.EqualFold(origin, value) {
			return true
		}
	}
	return false
}
