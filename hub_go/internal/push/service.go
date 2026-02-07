package push

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"hub_go/internal/config"
	"hub_go/internal/store"
)

// PushPayload represents a push notification payload
type PushPayload struct {
	Title string            `json:"title"`
	Body  string            `json:"body"`
	Tag   string            `json:"tag,omitempty"`
	Data  *PushPayloadData  `json:"data,omitempty"`
}

// PushPayloadData contains additional data for the push notification
type PushPayloadData struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	URL       string `json:"url"`
}

// Service handles sending push notifications
type Service struct {
	vapidKeys  *config.VapidKeys
	subject    string
	store      *store.Store
	httpClient *http.Client
	privateKey *ecdsa.PrivateKey
}

// NewService creates a new push notification service
func NewService(vapidKeys *config.VapidKeys, subject string, store *store.Store) (*Service, error) {
	if vapidKeys == nil || vapidKeys.PublicKey == "" || vapidKeys.PrivateKey == "" {
		return nil, errors.New("invalid VAPID keys")
	}

	// Decode private key
	privBytes, err := base64.RawURLEncoding.DecodeString(vapidKeys.PrivateKey)
	if err != nil {
		return nil, fmt.Errorf("failed to decode private key: %w", err)
	}

	curve := elliptic.P256()
	x, y := curve.ScalarBaseMult(privBytes)

	privateKey := &ecdsa.PrivateKey{
		PublicKey: ecdsa.PublicKey{
			Curve: curve,
			X:     x,
			Y:     y,
		},
	}
	privateKey.D = new(big.Int).SetBytes(privBytes)

	return &Service{
		vapidKeys:  vapidKeys,
		subject:    subject,
		store:      store,
		httpClient: &http.Client{Timeout: 30 * time.Second},
		privateKey: privateKey,
	}, nil
}

// SendToNamespace sends a push notification to all subscriptions in a namespace
func (s *Service) SendToNamespace(namespace string, payload PushPayload) error {
	if s == nil || s.store == nil {
		return nil
	}

	subscriptions := s.store.GetPushSubscriptionsByNamespace(namespace)
	if len(subscriptions) == 0 {
		return nil
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	for _, sub := range subscriptions {
		if err := s.sendToSubscription(namespace, sub, body); err != nil {
			log.Printf("[PushService] Failed to send to %s: %v", sub.Endpoint, err)
		}
	}

	return nil
}

func (s *Service) sendToSubscription(namespace string, sub store.PushSubscription, body []byte) error {
	// Encrypt the payload
	encryptedPayload, err := s.encryptPayload(sub, body)
	if err != nil {
		return fmt.Errorf("failed to encrypt payload: %w", err)
	}

	// Create VAPID authorization header
	vapidHeader, err := s.createVAPIDHeader(sub.Endpoint)
	if err != nil {
		return fmt.Errorf("failed to create VAPID header: %w", err)
	}

	req, err := http.NewRequest("POST", sub.Endpoint, bytes.NewReader(encryptedPayload))
	if err != nil {
		return err
	}

	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("TTL", "86400")
	req.Header.Set("Authorization", vapidHeader)

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	// Handle 410 Gone - subscription expired
	if resp.StatusCode == http.StatusGone {
		s.store.DeletePushSubscription(namespace, sub.Endpoint)
		return nil
	}

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("push failed with status %d: %s", resp.StatusCode, string(body))
	}

	return nil
}

func (s *Service) encryptPayload(sub store.PushSubscription, payload []byte) ([]byte, error) {
	// Decode subscriber's public key
	p256dhBytes, err := base64.RawURLEncoding.DecodeString(sub.P256dh)
	if err != nil {
		return nil, fmt.Errorf("failed to decode p256dh: %w", err)
	}

	// Decode auth secret
	authSecret, err := base64.RawURLEncoding.DecodeString(sub.Auth)
	if err != nil {
		return nil, fmt.Errorf("failed to decode auth: %w", err)
	}

	// Generate ephemeral key pair
	curve := ecdh.P256()
	ephemeralPrivate, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	ephemeralPublic := ephemeralPrivate.PublicKey()

	// Parse subscriber's public key
	subscriberPublic, err := curve.NewPublicKey(p256dhBytes)
	if err != nil {
		return nil, fmt.Errorf("failed to parse subscriber public key: %w", err)
	}

	// Perform ECDH
	sharedSecret, err := ephemeralPrivate.ECDH(subscriberPublic)
	if err != nil {
		return nil, err
	}

	// Derive keys using HKDF
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}

	// PRK = HKDF-Extract(auth_secret, shared_secret)
	prkInfo := append([]byte("WebPush: info\x00"), p256dhBytes...)
	prkInfo = append(prkInfo, ephemeralPublic.Bytes()...)

	prk := hkdfExtract(authSecret, sharedSecret)
	ikm := hkdfExpand(prk, prkInfo, 32)

	// Derive content encryption key and nonce
	contentPrk := hkdfExtract(salt, ikm)
	cek := hkdfExpand(contentPrk, []byte("Content-Encoding: aes128gcm\x00"), 16)
	nonce := hkdfExpand(contentPrk, []byte("Content-Encoding: nonce\x00"), 12)

	// Encrypt with AES-128-GCM
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}

	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	// Add padding
	paddedPayload := make([]byte, len(payload)+1)
	copy(paddedPayload, payload)
	paddedPayload[len(payload)] = 2 // Padding delimiter

	ciphertext := aead.Seal(nil, nonce, paddedPayload, nil)

	// Build the aes128gcm record
	recordSize := uint32(4096)
	header := make([]byte, 21+len(ephemeralPublic.Bytes()))
	copy(header[0:16], salt)
	binary.BigEndian.PutUint32(header[16:20], recordSize)
	header[20] = byte(len(ephemeralPublic.Bytes()))
	copy(header[21:], ephemeralPublic.Bytes())

	result := append(header, ciphertext...)
	return result, nil
}

func (s *Service) createVAPIDHeader(endpoint string) (string, error) {
	// Parse endpoint URL to get audience
	audience := extractAudience(endpoint)

	now := time.Now()
	claims := jwt.MapClaims{
		"aud": audience,
		"exp": now.Add(12 * time.Hour).Unix(),
		"sub": s.subject,
	}

	token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	signedToken, err := token.SignedString(s.privateKey)
	if err != nil {
		return "", err
	}

	return fmt.Sprintf("vapid t=%s, k=%s", signedToken, s.vapidKeys.PublicKey), nil
}

func extractAudience(endpoint string) string {
	// Extract scheme://host from endpoint
	for i := 0; i < len(endpoint); i++ {
		if endpoint[i] == '/' && i+1 < len(endpoint) && endpoint[i+1] == '/' {
			// Found ://
			for j := i + 2; j < len(endpoint); j++ {
				if endpoint[j] == '/' {
					return endpoint[:j]
				}
			}
			return endpoint
		}
	}
	return endpoint
}

// HKDF helper functions
func hkdfExtract(salt, ikm []byte) []byte {
	h := hmacSHA256(salt, ikm)
	return h
}

func hkdfExpand(prk, info []byte, length int) []byte {
	hashLen := 32
	n := (length + hashLen - 1) / hashLen
	okm := make([]byte, 0, n*hashLen)
	var prev []byte

	for i := 1; i <= n; i++ {
		data := append(prev, info...)
		data = append(data, byte(i))
		prev = hmacSHA256(prk, data)
		okm = append(okm, prev...)
	}

	return okm[:length]
}

func hmacSHA256(key, data []byte) []byte {
	h := sha256.New
	mac := hmac.New(h, key)
	mac.Write(data)
	return mac.Sum(nil)
}
