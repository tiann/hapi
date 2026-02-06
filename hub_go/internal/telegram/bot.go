package telegram

import (
	"context"
)

type Bot struct {
	Token string
}

func NewBot(token string) *Bot {
	if token == "" {
		return nil
	}
	return &Bot{Token: token}
}

func (b *Bot) Start(ctx context.Context) error {
	if b == nil {
		return nil
	}
	<-ctx.Done()
	return nil
}
