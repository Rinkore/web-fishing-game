package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"fishing.local/server/internal/rules"
)

func TestApplicationVersionDoesNotRequireGameplayCatalog(t *testing.T) {
	c, err := rules.Default()
	if err != nil {
		t.Fatal(err)
	}
	var expectedVersion, expectedBuild string
	if err := c.Constant("VERSION", &expectedVersion); err != nil {
		t.Fatal(err)
	}
	if err := c.Constant("BUILD", &expectedBuild); err != nil {
		t.Fatal(err)
	}
	// A nil database makes an accidental dependency on a published gameplay
	// catalog fail, even when PostgreSQL integration tests are not configured.
	response := httptest.NewRecorder()
	(&API{}).legacyVersion(response, httptest.NewRequest(http.MethodGet, "/api/version", nil))
	var actual map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &actual); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || actual["version"] != expectedVersion || actual["build"] != expectedBuild {
		t.Fatalf("application version: %d %v", response.Code, actual)
	}
}
