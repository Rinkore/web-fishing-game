package operations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

type AutoNotifyRule struct {
	Min   int    `json:"min"`
	Level string `json:"level"`
}

type AutoNotifyConfig struct {
	On            bool             `json:"on"`
	Rules         []AutoNotifyRule `json:"rules"`
	HysteresisPct float64          `json:"hysteresisPct"`
	HoldCount     int              `json:"holdCount"`
}

func DefaultAutoNotify() AutoNotifyConfig {
	return AutoNotifyConfig{Rules: []AutoNotifyRule{}, HysteresisPct: 10, HoldCount: 2}
}

func ParseAutoNotify(raw json.RawMessage, previous AutoNotifyConfig) (AutoNotifyConfig, error) {
	var patch map[string]json.RawMessage
	bad := errors.New("invalid auto notification configuration")
	if json.Unmarshal(raw, &patch) != nil || patch == nil {
		return previous, bad
	}
	for key := range patch {
		switch key {
		case "on", "rules", "hysteresisPct", "holdCount", "preset":
		default:
			return previous, bad
		}
		if string(patch[key]) == "null" {
			return previous, bad
		}
	}
	if json.Unmarshal(raw, &previous) != nil {
		return previous, bad
	}
	if presetRaw, exists := patch["preset"]; exists {
		var preset string
		if json.Unmarshal(presetRaw, &preset) != nil {
			return previous, bad
		}
		switch preset {
		case "default":
			previous.Rules = []AutoNotifyRule{{800, "uncommon"}, {2000, "records"}, {4000, "none"}}
		case "relaxed":
			previous.Rules = []AutoNotifyRule{{1500, "records"}, {4000, "none"}}
		default:
			return previous, bad
		}
	}
	if math.IsNaN(previous.HysteresisPct) || math.IsInf(previous.HysteresisPct, 0) || previous.HysteresisPct < 0 || previous.HysteresisPct > 90 || previous.HoldCount < 1 || previous.HoldCount > 12 || len(previous.Rules) > 32 {
		return previous, bad
	}
	seen := map[int]bool{}
	for _, rule := range previous.Rules {
		if rule.Min < 0 || rule.Min > 10000000 || seen[rule.Min] {
			return previous, bad
		}
		seen[rule.Min] = true
		switch rule.Level {
		case "all", "uncommon", "offrange", "records", "none":
		default:
			return previous, bad
		}
	}
	sort.Slice(previous.Rules, func(i, j int) bool { return previous.Rules[i].Min < previous.Rules[j].Min })
	if previous.Rules == nil {
		previous.Rules = []AutoNotifyRule{}
	}
	return previous, nil
}

type autoNotifyState struct {
	Config    string `json:"config"`
	NextAt    int64  `json:"nextAt"`
	Candidate string `json:"candidate"`
	Count     int    `json:"count"`
}

func nextAutoNotify(cfg AutoNotifyConfig, current string, online int64, state autoNotifyState) (string, autoNotifyState) {
	if !cfg.On {
		state.Candidate, state.Count = "", 0
		return current, state
	}
	if current == "rare" {
		current = "uncommon"
	}
	if current == "off" {
		current = "none"
	}
	target, threshold, currentThreshold := "all", 0, 0
	for _, rule := range cfg.Rules {
		if online >= int64(rule.Min) {
			target, threshold = rule.Level, rule.Min
		}
		if rule.Level == current {
			currentThreshold = rule.Min
		}
	}
	if threshold < currentThreshold && float64(online)*100 >= float64(currentThreshold)*(100-cfg.HysteresisPct) {
		target = current
	}
	if threshold > currentThreshold && float64(online)*100 < float64(threshold)*(100+cfg.HysteresisPct) {
		target = current
	}
	if target == current {
		state.Candidate, state.Count = "", 0
		return current, state
	}
	if state.Candidate != target {
		state.Candidate, state.Count = target, 0
	}
	state.Count++
	if state.Count >= cfg.HoldCount {
		current = target
		state.Candidate, state.Count = "", 0
	}
	return current, state
}

// AutoNotifyOnce shares the operator setting row lock with manual saves. The
// persisted nextAt and candidate avoid double-counting a tick on two servers.
func (s *Service) AutoNotifyOnce(ctx context.Context) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var raw []byte
	var now time.Time
	if err = tx.QueryRow(ctx, `SELECT value,clock_timestamp() FROM fishing.operator_settings WHERE key='legacy:settings' FOR UPDATE`).Scan(&raw, &now); errors.Is(err, pgx.ErrNoRows) {
		return nil
	} else if err != nil {
		return err
	}
	var settings map[string]json.RawMessage
	if json.Unmarshal(raw, &settings) != nil {
		return errors.New("invalid notification settings")
	}
	if len(settings["autoNotify"]) == 0 {
		return nil
	}
	cfg, err := ParseAutoNotify(settings["autoNotify"], DefaultAutoNotify())
	if err != nil {
		return err
	}
	if !cfg.On {
		return nil
	}
	var state autoNotifyState
	_ = json.Unmarshal(settings["autoNotifyState"], &state)
	canonical, _ := json.Marshal(cfg)
	digest := sha256.Sum256(canonical)
	configID := hex.EncodeToString(digest[:])
	if state.Config != configID {
		state = autoNotifyState{Config: configID}
	}
	if now.UnixMilli() < state.NextAt {
		return nil
	}
	current := "all"
	_ = json.Unmarshal(settings["notifyLevel"], &current)
	var online int64
	if cfg.On {
		if err = tx.QueryRow(ctx, `SELECT count(DISTINCT owner_id) FROM fishing.gateway_streams WHERE expires_at>clock_timestamp()`).Scan(&online); err != nil {
			return err
		}
	}
	level, state := nextAutoNotify(cfg, current, online, state)
	state.NextAt = now.Truncate(5 * time.Second).Add(5 * time.Second).UnixMilli()
	settings["autoNotifyState"], _ = json.Marshal(state)
	settings["notifyLevel"], _ = json.Marshal(level)
	encoded, _ := json.Marshal(settings)
	if _, err = tx.Exec(ctx, `UPDATE fishing.operator_settings SET value=$1,updated_at=clock_timestamp() WHERE key='legacy:settings'`, encoded); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
