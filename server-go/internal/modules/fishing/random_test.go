package fishing

import "testing"

func TestStableRandomVectors(t *testing.T) {
	// Independently computed with Node crypto.createHmac for the documented
	// domain and four big-endian uint64 fields, using an all-zero synthetic seed.
	seed := make([]byte, 32)
	for i, want := range []uint64{309391, 765697, 743875} {
		if got := sample(seed, 1, 1, int64(i+1), 1000000); got != want {
			t.Fatalf("sequence %d: %d != %d", i+1, got, want)
		}
	}
}
