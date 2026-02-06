package telegram

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

type User struct {
	ID           int64  `json:"id"`
	IsBot        *bool  `json:"is_bot,omitempty"`
	FirstName    string `json:"first_name,omitempty"`
	LastName     string `json:"last_name,omitempty"`
	Username     string `json:"username,omitempty"`
	LanguageCode string `json:"language_code,omitempty"`
}

type ValidationResult struct {
	OK       bool
	User     User
	AuthDate int64
	Raw      map[string]string
	Error    string
}

func ValidateInitData(initData string, botToken string, maxAge time.Duration) ValidationResult {
	params, err := url.ParseQuery(initData)
	if err != nil {
		return ValidationResult{OK: false, Error: "Missing hash"}
	}

	hash := params.Get("hash")
	if hash == "" {
		return ValidationResult{OK: false, Error: "Missing hash"}
	}

	entries := map[string]string{}
	for key, values := range params {
		if len(values) > 0 {
			entries[key] = values[0]
		}
	}

	authDateRaw := entries["auth_date"]
	authDate, err := strconv.ParseInt(authDateRaw, 10, 64)
	if err != nil {
		return ValidationResult{OK: false, Error: "Missing or invalid auth_date"}
	}

	nowSeconds := time.Now().Unix()
	if nowSeconds-authDate > int64(maxAge.Seconds()) {
		return ValidationResult{OK: false, Error: "initData is too old"}
	}

	dataCheckString := computeDataCheckString(entries)
	if !validHash(hash, dataCheckString, botToken) {
		return ValidationResult{OK: false, Error: "Invalid initData signature"}
	}

	userRaw := entries["user"]
	if userRaw == "" {
		return ValidationResult{OK: false, Error: "Missing user"}
	}

	var user User
	if err := json.Unmarshal([]byte(userRaw), &user); err != nil {
		return ValidationResult{OK: false, Error: "Invalid user JSON"}
	}

	if user.ID == 0 {
		return ValidationResult{OK: false, Error: "Invalid user schema"}
	}

	return ValidationResult{OK: true, User: user, AuthDate: authDate, Raw: entries}
}

func computeDataCheckString(entries map[string]string) string {
	keys := make([]string, 0, len(entries))
	for key := range entries {
		if key == "hash" {
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)

	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, key+"="+entries[key])
	}
	return strings.Join(parts, "\n")
}

func validHash(hash string, dataCheckString string, botToken string) bool {
	secretKeys := deriveSecretKeys(botToken)
	for _, key := range secretKeys {
		expected := computeExpectedHashHex(key, dataCheckString)
		if safeCompareHex(hash, expected) {
			return true
		}
	}
	return false
}

func deriveSecretKeys(botToken string) [][]byte {
	hmacKeyConstThenToken := hmacSHA256([]byte("WebAppData"), []byte(botToken))
	hmacKeyTokenThenConst := hmacSHA256([]byte(botToken), []byte("WebAppData"))
	shaBotToken := sha256.Sum256([]byte(botToken))
	return [][]byte{hmacKeyConstThenToken, hmacKeyTokenThenConst, shaBotToken[:]}
}

func computeExpectedHashHex(secretKey []byte, dataCheckString string) string {
	digest := hmacSHA256(secretKey, []byte(dataCheckString))
	return hex.EncodeToString(digest)
}

func safeCompareHex(aHex string, bHex string) bool {
	a, err := hex.DecodeString(aHex)
	if err != nil {
		return false
	}
	b, err := hex.DecodeString(bHex)
	if err != nil {
		return false
	}
	if len(a) != len(b) {
		return false
	}
	return hmac.Equal(a, b)
}

func hmacSHA256(key []byte, data []byte) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(data)
	return mac.Sum(nil)
}
