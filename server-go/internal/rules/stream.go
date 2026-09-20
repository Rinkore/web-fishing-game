package rules

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
)

// Stream v1 maps a durable private seed and domain to ordered 53-bit draws.
func Stream(seed []byte, domain string) RNG {
	var counter uint64
	return func() float64 {
		h := hmac.New(sha256.New, seed)
		_, _ = h.Write([]byte("fishing-rules-rng-v1:" + domain + ":"))
		var b [8]byte
		binary.BigEndian.PutUint64(b[:], counter)
		counter++
		_, _ = h.Write(b[:])
		n := binary.BigEndian.Uint64(h.Sum(nil)[:8]) >> 11
		return float64(n) / 9007199254740992
	}
}
