package fishing

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
)

// Private persisted seed + cycle identity give stable retry results. Rejection
// sampling avoids modulo bias. The version/domain is part of the PRF input.
func sample(seed []byte, session, generation, seq int64, n uint64) uint64 {
	var input [32]byte
	binary.BigEndian.PutUint64(input[0:8], uint64(session))
	binary.BigEndian.PutUint64(input[8:16], uint64(generation))
	binary.BigEndian.PutUint64(input[16:24], uint64(seq))
	threshold := -n % n
	for counter := uint64(0); ; counter++ {
		binary.BigEndian.PutUint64(input[24:32], counter)
		mac := hmac.New(sha256.New, seed)
		mac.Write([]byte("fishing-hmac-sha256-v1:bite:"))
		mac.Write(input[:])
		x := binary.BigEndian.Uint64(mac.Sum(nil)[:8])
		if x >= threshold {
			return x % n
		}
	}
}
