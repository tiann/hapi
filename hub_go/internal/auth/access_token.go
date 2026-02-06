package auth

import "strings"

const DefaultNamespace = "default"

type ParsedAccessToken struct {
	BaseToken string
	Namespace string
}

func ParseAccessToken(raw string) *ParsedAccessToken {
	if raw == "" {
		return nil
	}

	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}

	separator := strings.LastIndex(trimmed, ":")
	if separator == -1 {
		return &ParsedAccessToken{BaseToken: trimmed, Namespace: DefaultNamespace}
	}

	baseToken := trimmed[:separator]
	namespace := trimmed[separator+1:]
	if baseToken == "" || namespace == "" {
		return nil
	}

	if strings.TrimSpace(baseToken) != baseToken || strings.TrimSpace(namespace) != namespace {
		return nil
	}

	return &ParsedAccessToken{BaseToken: baseToken, Namespace: namespace}
}
