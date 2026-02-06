package httpserver

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"

	"hub_go/internal/auth"
)

type Middleware func(HandlerFunc) HandlerFunc

type authContextKey string

const (
	userIDKey    authContextKey = "userId"
	namespaceKey authContextKey = "namespace"
)

func withMiddleware(handler HandlerFunc, middlewares ...Middleware) HandlerFunc {
	if len(middlewares) == 0 {
		return handler
	}

	wrapped := handler
	for i := len(middlewares) - 1; i >= 0; i-- {
		wrapped = middlewares[i](wrapped)
	}
	return wrapped
}

func AuthMiddleware(jwtSecret []byte) Middleware {
	return func(next HandlerFunc) HandlerFunc {
		return func(w http.ResponseWriter, req *http.Request, params Params) {
			path := req.URL.Path
			if path == "/api/auth" || path == "/api/bind" {
				next(w, req, params)
				return
			}

			token := tokenFromRequest(req)
			if token == "" {
				writeJSON(w, http.StatusUnauthorized, map[string]string{
					"error": "Missing authorization token",
				})
				return
			}

			claims := struct {
				UID float64 `json:"uid"`
				NS  string  `json:"ns"`
				jwt.RegisteredClaims
			}{}

			parsed, err := jwt.ParseWithClaims(token, &claims, func(token *jwt.Token) (any, error) {
				if token.Method != jwt.SigningMethodHS256 {
					return nil, errors.New("unexpected signing method")
				}
				return jwtSecret, nil
			})
			if err != nil || !parsed.Valid {
				writeJSON(w, http.StatusUnauthorized, map[string]string{
					"error": "Invalid token",
				})
				return
			}

			if claims.NS == "" || claims.UID == 0 {
				writeJSON(w, http.StatusUnauthorized, map[string]string{
					"error": "Invalid token payload",
				})
				return
			}

			ctx := context.WithValue(req.Context(), userIDKey, int64(claims.UID))
			ctx = context.WithValue(ctx, namespaceKey, claims.NS)

			next(w, req.WithContext(ctx), params)
		}
	}
}

func CliAuthMiddleware(cliApiToken string) Middleware {
	return func(next HandlerFunc) HandlerFunc {
		return func(w http.ResponseWriter, req *http.Request, params Params) {
			w.Header().Set("X-Hapi-Protocol-Version", "1")

			authorization := req.Header.Get("Authorization")
			if authorization == "" {
				writeJSON(w, http.StatusUnauthorized, map[string]string{
					"error": "Missing Authorization header",
				})
				return
			}

			if !strings.HasPrefix(strings.ToLower(authorization), "bearer ") {
				writeJSON(w, http.StatusUnauthorized, map[string]string{
					"error": "Invalid Authorization header",
				})
				return
			}

			rawToken := strings.TrimSpace(authorization[len("Bearer "):])
			parsed := auth.ParseAccessToken(rawToken)
			if parsed == nil || !auth.ConstantTimeEquals(parsed.BaseToken, cliApiToken) {
				writeJSON(w, http.StatusUnauthorized, map[string]string{
					"error": "Invalid token",
				})
				return
			}

			ctx := context.WithValue(req.Context(), namespaceKey, parsed.Namespace)
			next(w, req.WithContext(ctx), params)
		}
	}
}

func tokenFromRequest(req *http.Request) string {
	authorization := req.Header.Get("Authorization")
	if strings.HasPrefix(strings.ToLower(authorization), "bearer ") {
		return strings.TrimSpace(authorization[len("Bearer "):])
	}

	if req.URL.Path == "/api/events" {
		return req.URL.Query().Get("token")
	}

	return ""
}
