package gateway

import (
	"net"
	"net/http"
	"os"
	"strconv"

	"fishing.local/server/internal/modules/identity"
)

func registrationLimits() identity.RegistrationLimits {
	limits := identity.DefaultRegistrationLimits()
	for key, dst := range map[string]*int64{"REGISTER_GLOBAL_HOURLY": &limits.GlobalHourly, "REGISTER_IP_HOURLY": &limits.IPHourly} {
		if n, err := strconv.ParseInt(os.Getenv(key), 10, 64); err == nil && n > 0 && n <= 9007199254740991 {
			*dst = n
		}
	}
	return limits
}

// Forwarded headers are not source authority. A trusted-proxy policy must be
// configured separately before putting public registration behind a proxy.
func registrationSource(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.String()
	}
	return host
}

func (a *API) registerChallenge(w http.ResponseWriter, r *http.Request) {
	challenge, err := a.identity.IssueRegistrationChallenge(r.Context(), registrationSource(r))
	if err != nil {
		failure(w, err)
		return
	}
	write(w, 200, challenge)
}
