package identity

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"strconv"
	"strings"
)

func totp(secret string, step int64) string {
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(strings.TrimRight(secret, "=")))
	if err != nil || len(key) < 10 {
		return ""
	}
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], uint64(step))
	h := hmac.New(sha1.New, key)
	_, _ = h.Write(b[:])
	digest := h.Sum(nil)
	offset := digest[len(digest)-1] & 15
	n := binary.BigEndian.Uint32(digest[offset:offset+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", n%1000000)
}
func verifyOTP(secret, code string, nowStep, lastStep int64) (int64, bool) {
	if len(code) != 6 {
		return 0, false
	}
	if _, err := strconv.Atoi(code); err != nil {
		return 0, false
	}
	for _, step := range []int64{nowStep - 1, nowStep, nowStep + 1} {
		if step > lastStep && subtle.ConstantTimeCompare([]byte(totp(secret, step)), []byte(code)) == 1 {
			return step, true
		}
	}
	return 0, false
}
func mfaCipher(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, ErrMFASetup
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrMFASetup
	}
	return cipher.NewGCM(block)
}
func EncryptMFA(key []byte, accountID int64, secret string) ([]byte, error) {
	a, err := mfaCipher(key)
	if err != nil {
		return nil, err
	}
	if totp(secret, 1) == "" {
		return nil, ErrInvalid
	}
	nonce := make([]byte, a.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return a.Seal(nonce, nonce, []byte(secret), []byte(strconv.FormatInt(accountID, 10))), nil
}
func decryptMFA(key []byte, accountID int64, sealed []byte) (string, error) {
	a, err := mfaCipher(key)
	if err != nil || len(sealed) < a.NonceSize() {
		return "", ErrMFASetup
	}
	b, err := a.Open(nil, sealed[:a.NonceSize()], sealed[a.NonceSize():], []byte(strconv.FormatInt(accountID, 10)))
	if err != nil {
		return "", ErrMFASetup
	}
	return string(b), nil
}
