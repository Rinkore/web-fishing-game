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
	"net/url"
	"strconv"
	"strings"
	"time"
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
// VerifyMFA reports whether code matches secret's current time step (or one
// step either side, to tolerate clock skew). Console enrollment uses it to
// confirm the administrator really captured the pending secret before that
// secret is written, so a mistyped key can never lock the account out.
func VerifyMFA(secret, code string) bool {
	_, ok := verifyOTP(secret, strings.TrimSpace(code), time.Now().Unix()/30, -1)
	return ok
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

// NewMFASecret mints a fresh authenticator secret: 20 random bytes rendered as
// unpadded Base32, the same encoding the operator CLI accepts. Enrollment
// callers show it exactly once and never persist or log the plaintext.
func NewMFASecret() (string, error) {
	var raw [20]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", ErrBusy
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw[:]), nil
}

// MFAAuthURL renders the otpauth:// enrollment link for one account. The
// parameters mirror verifyOTP: SHA-1, six digits and a 30 second step.
func MFAAuthURL(issuer, account, secret string) string {
	query := url.Values{
		"secret":    {secret},
		"issuer":    {issuer},
		"algorithm": {"SHA1"},
		"digits":    {"6"},
		"period":    {"30"},
	}
	return "otpauth://totp/" + url.PathEscape(issuer+":"+account) + "?" + query.Encode()
}

// SealMFA encrypts one account's authenticator secret with the service key, so
// console enrollment writes exactly the ciphertext the operator CLI writes.
func (s *Service) SealMFA(accountID int64, secret string) ([]byte, error) {
	return EncryptMFA(s.mfaKey, accountID, secret)
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
