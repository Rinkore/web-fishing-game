package identity

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
	"unicode/utf16"

	"golang.org/x/crypto/scrypt"
)

var ErrInvalid = errors.New("invalid identity input")
var ErrCredentials = errors.New("invalid credentials")
var ErrBusy = errors.New("authentication busy; retry later")
var ErrExists = errors.New("username already exists")
var ErrBanned = errors.New("account banned")
var ErrForbidden = errors.New("administrator required")
var ErrMFASetup = errors.New("MFA_SETUP_REQUIRED")
var ErrStorage = errors.New("identity storage unavailable")
var ErrCommitUnknown = errors.New("identity commit outcome unknown; log in to recover")
var hashPattern = regexp.MustCompile(`^scrypt\$v1\$[a-f0-9]{32}\$[a-f0-9]{64}$`)
var legacyHashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var kdfSlots = make(chan struct{}, 4)

func PasswordPolicy(password string, minLength int) bool {
	n := len(utf16.Encode([]rune(password)))
	if n < minLength || n > 256 {
		return false
	}
	switch strings.ToLower(password) {
	case "password1234", "123456789012", "qwerty123456", "123456abcdef", "abcdefghijkl":
		return false
	}
	rr := []rune(password)
	same := true
	for _, r := range rr {
		if r != rr[0] {
			same = false
			break
		}
	}
	return !same
}
func derive(password, salt string) ([]byte, error) {
	select {
	case kdfSlots <- struct{}{}:
		defer func() { <-kdfSlots }()
	default:
		return nil, ErrBusy
	}
	return scrypt.Key([]byte(password), []byte(salt), 32768, 8, 1, 32)
}
func HashPassword(password string) (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", ErrBusy
	}
	salt := hex.EncodeToString(b[:])
	h, err := derive(password, salt)
	if err != nil {
		return "", err
	}
	return "scrypt$v1$" + salt + "$" + hex.EncodeToString(h), nil
}
func VerifyPassword(stored, salt, password string) (bool, error) {
	if len(password) > 1024 {
		return false, nil
	}
	var actual, expected []byte
	if hashPattern.MatchString(stored) {
		parts := strings.Split(stored, "$")
		var err error
		actual, err = derive(password, parts[2])
		if err != nil {
			return false, err
		}
		expected, _ = hex.DecodeString(parts[3])
	} else if legacyHashPattern.MatchString(stored) {
		h := sha256.Sum256([]byte(salt + ":" + password))
		actual = h[:]
		expected, _ = hex.DecodeString(stored)
	} else {
		return false, nil
	}
	return subtle.ConstantTimeCompare(actual, expected) == 1, nil
}
