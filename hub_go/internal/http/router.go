package httpserver

import (
    "context"
    "net/http"
    "strings"
)

type Params map[string]string

const paramsKey contextKey = "routeParams"

type contextKey string

type HandlerFunc func(http.ResponseWriter, *http.Request, Params)

type route struct {
    method  string
    pattern string
    handler HandlerFunc
}

type Router struct {
    routes   []route
    fallback http.Handler
}

func NewRouter() *Router {
    return &Router{routes: make([]route, 0)}
}

func (r *Router) Handle(method string, pattern string, handler HandlerFunc) {
    r.routes = append(r.routes, route{
        method:  method,
        pattern: pattern,
        handler: handler,
    })
}

func (r *Router) SetFallback(h http.Handler) {
    r.fallback = h
}

func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
    for _, rt := range r.routes {
        if rt.method != req.Method {
            continue
        }
        params, ok := matchPattern(rt.pattern, req.URL.Path)
        if !ok {
            continue
        }
        ctx := context.WithValue(req.Context(), paramsKey, params)
        rt.handler(w, req.WithContext(ctx), params)
        return
    }

    if r.fallback != nil {
        r.fallback.ServeHTTP(w, req)
        return
    }

    writeJSON(w, http.StatusNotFound, map[string]string{
        "error": "not_found",
    })
}

func matchPattern(pattern string, path string) (Params, bool) {
    if pattern == path {
        return Params{}, true
    }

    patternSegments := splitPath(pattern)
    pathSegments := splitPath(path)
    if len(patternSegments) != len(pathSegments) {
        return nil, false
    }

    params := Params{}
    for i, segment := range patternSegments {
        if strings.HasPrefix(segment, ":") {
            key := strings.TrimPrefix(segment, ":")
            if key == "" {
                return nil, false
            }
            params[key] = pathSegments[i]
            continue
        }
        if segment != pathSegments[i] {
            return nil, false
        }
    }

    return params, true
}

func splitPath(path string) []string {
    trimmed := strings.Trim(path, "/")
    if trimmed == "" {
        return []string{}
    }
    return strings.Split(trimmed, "/")
}

func ParamsFromContext(ctx context.Context) Params {
    if ctx == nil {
        return Params{}
    }
    params, _ := ctx.Value(paramsKey).(Params)
    if params == nil {
        return Params{}
    }
    return params
}
