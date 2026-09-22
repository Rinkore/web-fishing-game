package assets

import (
	"encoding/json"
	"testing"
)

func TestAttributesPreserveUnicode(t *testing.T) {
	for _, raw := range []string{`{"\u0000":1}`, `{"x":"\ud800"}`, `{"\udfff":1}`, `{"x":"\ud800a"}`, `{"x":"\ud800\u0041"}`, `{"x":"\udfff\ud800"}`} {
		if _, err := canonicalAttributes([]byte(raw)); err == nil {
			t.Fatalf("invalid Unicode accepted: %s", raw)
		}
	}
	for _, raw := range []string{`{"x":"\ud83c\udfa3"}`, `{"x":"🎣"}`, `{"x":"\\ud800"}`, `{"x":"�"}`, `{"x":"\\\""}`} {
		data, err := canonicalAttributes([]byte(raw))
		if err != nil {
			t.Fatalf("valid Unicode rejected: %s", raw)
		}
		var before, after map[string]string
		if json.Unmarshal([]byte(raw), &before) != nil || json.Unmarshal(data, &after) != nil || before["x"] != after["x"] {
			t.Fatal("attribute changed after normalization")
		}
	}
}
