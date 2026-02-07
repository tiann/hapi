package sync

import (
	"encoding/json"
	"errors"
	"time"
)

type RpcSender func(method string, payload any) (<-chan json.RawMessage, error)

type RpcGateway struct {
	send RpcSender
}

func NewRpcGateway(sender RpcSender) *RpcGateway {
	if sender == nil {
		return &RpcGateway{}
	}
	return &RpcGateway{send: sender}
}

func (g *RpcGateway) Call(method string, payload any, timeout time.Duration) (json.RawMessage, error) {
	if g == nil || g.send == nil {
		return nil, errors.New("not connected")
	}
	ch, err := g.send(method, payload)
	if err != nil {
		return nil, err
	}
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	select {
	case resp := <-ch:
		return resp, nil
	case <-time.After(timeout):
		return nil, errors.New("rpc timeout")
	}
}
