package config

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"errors"
)

type VapidKeys struct {
	PublicKey  string `json:"publicKey"`
	PrivateKey string `json:"privateKey"`
}

func LoadOrCreateVapidKeys(settingsFile string) (*VapidKeys, error) {
	settings, err := readSettings(settingsFile)
	if err != nil {
		return nil, err
	}

	if settings.VapidKeys != nil && settings.VapidKeys.PublicKey != "" && settings.VapidKeys.PrivateKey != "" {
		return settings.VapidKeys, nil
	}

	keys, err := generateVapidKeys()
	if err != nil {
		return nil, err
	}
	settings.VapidKeys = keys
	if err := writeSettings(settingsFile, settings); err != nil {
		return nil, err
	}
	return keys, nil
}

func generateVapidKeys() (*VapidKeys, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	if priv.D == nil || priv.X == nil || priv.Y == nil {
		return nil, errors.New("invalid key")
	}

	xBytes := pad32(priv.X.Bytes())
	yBytes := pad32(priv.Y.Bytes())
	pub := make([]byte, 65)
	pub[0] = 0x04
	copy(pub[1:33], xBytes)
	copy(pub[33:], yBytes)

	privateKey := base64.RawURLEncoding.EncodeToString(pad32(priv.D.Bytes()))
	publicKey := base64.RawURLEncoding.EncodeToString(pub)

	return &VapidKeys{
		PublicKey:  publicKey,
		PrivateKey: privateKey,
	}, nil
}

func pad32(input []byte) []byte {
	if len(input) >= 32 {
		return input
	}
	padded := make([]byte, 32)
	copy(padded[32-len(input):], input)
	return padded
}
