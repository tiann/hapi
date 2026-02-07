package auth

import "crypto/subtle"

func ConstantTimeEquals(a string, b string) bool {
	maxLen := len(a)
	if len(b) > maxLen {
		maxLen = len(b)
	}

	bufA := make([]byte, maxLen)
	bufB := make([]byte, maxLen)
	copy(bufA, a)
	copy(bufB, b)

	sameLen := subtle.ConstantTimeEq(int32(len(a)), int32(len(b)))
	sameBytes := subtle.ConstantTimeCompare(bufA, bufB)
	return (sameLen & sameBytes) == 1
}
