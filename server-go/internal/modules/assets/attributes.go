package assets

import (
	"bytes"
	"encoding/json"
	"io"
	"math/big"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Keep generated attributes exact: no float64 roundtrip, duplicate object
// keys, unbounded exponents, or silently substituted malformed data.
func canonicalAttributes(raw []byte) (json.RawMessage, error) {
	if !utf8.Valid(raw) || !json.Valid(raw) || !validAttributeEscapes(raw) {
		return nil, ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	v, err := attributeValue(d, 0)
	if err != nil {
		return nil, err
	}
	if _, ok := v.(map[string]any); !ok {
		return nil, ErrInvalid
	}
	if _, err = d.Token(); err != io.EOF {
		return nil, ErrInvalid
	}
	data, err := json.Marshal(v)
	return data, err
}
func attributeValue(d *json.Decoder, depth int) (any, error) {
	if depth > 32 {
		return nil, ErrInvalid
	}
	t, err := d.Token()
	if err != nil {
		return nil, err
	}
	switch v := t.(type) {
	case json.Delim:
		if v == '{' {
			m := map[string]any{}
			for d.More() {
				key, err := d.Token()
				if err != nil {
					return nil, err
				}
				name, ok := key.(string)
				if !ok || strings.ContainsRune(name, 0) {
					return nil, ErrInvalid
				}
				if _, exists := m[name]; exists {
					return nil, ErrInvalid
				}
				child, err := attributeValue(d, depth+1)
				if err != nil {
					return nil, err
				}
				m[name] = child
			}
			_, err = d.Token()
			return m, err
		}
		if v == '[' {
			out := []any{}
			for d.More() {
				child, err := attributeValue(d, depth+1)
				if err != nil {
					return nil, err
				}
				out = append(out, child)
			}
			_, err = d.Token()
			return out, err
		}
		return nil, ErrInvalid
	case json.Number:
		text := string(v)
		if len(text) > 256 {
			return nil, ErrInvalid
		}
		if i := strings.IndexAny(text, "eE"); i >= 0 {
			exponent, err := strconv.Atoi(text[i+1:])
			if err != nil || exponent > 400 || exponent < -400 {
				return nil, ErrInvalid
			}
		}
		r, ok := new(big.Rat).SetString(text)
		if !ok || new(big.Rat).Abs(r).Cmp(new(big.Rat).SetInt64(MaxCoins)) > 0 {
			return nil, ErrInvalid
		}
		return v, nil
	case string:
		if strings.ContainsRune(v, 0) {
			return nil, ErrInvalid
		}
		return v, nil
	default:
		return t, nil
	}
}

// encoding/json replaces unpaired UTF-16 surrogates with U+FFFD. Reject them
// before decoding so persisted equipment properties cannot silently change.
// JSON syntax has already been checked, so every escape is inside a string.
func validAttributeEscapes(raw []byte) bool {
	for i := 0; i < len(raw); i++ {
		if raw[i] != '\\' {
			continue
		}
		i++
		if raw[i] != 'u' {
			continue
		}
		n, _ := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		i += 4
		if n >= 0xdc00 && n <= 0xdfff {
			return false
		}
		if n >= 0xd800 && n <= 0xdbff {
			if i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
				return false
			}
			low, err := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			i += 6
		}
	}
	return true
}
