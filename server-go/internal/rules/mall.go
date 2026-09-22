package rules

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"time"
	_ "time/tzdata"
)

type MallItem struct {
	ID    string `json:"id"`
	Price int64  `json:"price"`
	Limit int64  `json:"limit"`
}
type MallConfig struct {
	RefreshTime string     `json:"refreshTime"`
	Items       []MallItem `json:"items"`
}
type MallCycle struct {
	Key         string `json:"key"`
	StartAt     int64  `json:"startAt"`
	NextAt      int64  `json:"nextAt"`
	RefreshTime string `json:"refreshTime"`
}

var refreshPattern = regexp.MustCompile(`^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$`)

func ParseRefreshTime(value string) (hour, minute int, ok bool) {
	m := refreshPattern.FindStringSubmatch(value)
	if m == nil {
		return
	}
	hour, _ = strconv.Atoi(m[1])
	minute, _ = strconv.Atoi(m[2])
	ok = hour < 24 && minute < 60
	return
}
func (c *Catalog) MallConfig() MallConfig {
	var cfg MallConfig
	_ = json.Unmarshal(c.Defaults["mall"], &cfg)
	return cfg
}

// wallTime follows JavaScript Date's compatible disambiguation: choose the
// earlier instant in a fold and advance through a gap. Go time.Date may choose
// the opposite side of a daylight-saving transition.
func wallTime(y int, m time.Month, d, h, minute int, loc *time.Location) time.Time {
	wall := time.Date(y, m, d, h, minute, 0, 0, time.UTC)
	offsets := map[int]bool{}
	for _, delta := range []time.Duration{-36 * time.Hour, 0, 36 * time.Hour} {
		_, offset := wall.Add(delta).In(loc).Zone()
		offsets[offset] = true
	}
	var exact, forward time.Time
	var distance time.Duration
	for offset := range offsets {
		candidate := wall.Add(-time.Duration(offset) * time.Second).In(loc)
		cy, cm, cd := candidate.Date()
		mapped := time.Date(cy, cm, cd, candidate.Hour(), candidate.Minute(), 0, 0, time.UTC)
		gap := mapped.Sub(wall)
		if gap == 0 && (exact.IsZero() || candidate.Before(exact)) {
			exact = candidate
		}
		if gap > 0 && (forward.IsZero() || gap < distance) {
			forward = candidate
			distance = gap
		}
	}
	if !exact.IsZero() {
		return exact
	}
	if !forward.IsZero() {
		return forward
	}
	return time.Date(y, m, d, h, minute, 0, 0, loc)
}
func nextWallDay(t time.Time, days int) time.Time {
	y, m, d := t.Date()
	return wallTime(y, m, d+days, t.Hour(), t.Minute(), t.Location())
}

// MallCycleOf uses calendar days in the configured server timezone, not 24h periods.
func MallCycleOf(refresh string, now time.Time) MallCycle {
	h, m, ok := ParseRefreshTime(refresh)
	if !ok {
		h, m = 4, 0
	}
	y, month, day := now.Date()
	start := wallTime(y, month, day, h, m, now.Location())
	if start.After(now) {
		start = nextWallDay(start, -1)
	}
	return MallCycle{Key: start.Format("2006-01-02"), StartAt: start.UnixMilli(), NextAt: nextWallDay(start, 1).UnixMilli(), RefreshTime: fmt.Sprintf("%d:%02d", h, m)}
}
