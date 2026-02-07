package auth

import "testing"

func TestConstantTimeEquals(t *testing.T) {
	tests := []struct {
		name string
		a    string
		b    string
		want bool
	}{
		{name: "both-empty", a: "", b: "", want: true},
		{name: "equal", a: "abc", b: "abc", want: true},
		{name: "different", a: "abc", b: "abd", want: false},
		{name: "different-length", a: "abc", b: "ab", want: false},
		{name: "null-bytes", a: "a\x00b", b: "a\x00b", want: true},
		{name: "null-bytes-length", a: "a\x00", b: "a", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ConstantTimeEquals(tt.a, tt.b); got != tt.want {
				t.Fatalf("ConstantTimeEquals(%q, %q) = %v; want %v", tt.a, tt.b, got, tt.want)
			}
		})
	}
}
