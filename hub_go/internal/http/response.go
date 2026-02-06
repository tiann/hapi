package httpserver

import (
    "encoding/json"
    "net/http"
)

func writeJSON(w http.ResponseWriter, status int, payload any) {
    w.Header().Set("Content-Type", "application/json; charset=utf-8")
    w.WriteHeader(status)
    if payload == nil {
        return
    }

    encoder := json.NewEncoder(w)
    encoder.SetEscapeHTML(false)
    _ = encoder.Encode(payload)
}
