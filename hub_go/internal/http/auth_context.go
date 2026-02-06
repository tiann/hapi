package httpserver

import "context"

func UserIDFromContext(ctx context.Context) (int64, bool) {
	if ctx == nil {
		return 0, false
	}
	value, ok := ctx.Value(userIDKey).(int64)
	return value, ok
}

func NamespaceFromContext(ctx context.Context) (string, bool) {
	if ctx == nil {
		return "", false
	}
	value, ok := ctx.Value(namespaceKey).(string)
	return value, ok
}
