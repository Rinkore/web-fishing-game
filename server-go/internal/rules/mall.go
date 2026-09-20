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

// MallCycleOf uses calendar days in the configured server timezone, not 24h periods.
func MallCycleOf(refresh string, now time.Time) MallCycle {
	h, m, ok := ParseRefreshTime(refresh)
	if !ok {
		h, m = 4, 0
	}
	y, month, day := now.Date()
	start := time.Date(y, month, day, h, m, 0, 0, now.Location())
	if start.After(now) {
		start = start.AddDate(0, 0, -1)
	}
	return MallCycle{Key: start.Format("2006-01-02"), StartAt: start.UnixMilli(), NextAt: start.AddDate(0, 0, 1).UnixMilli(), RefreshTime: fmt.Sprintf("%d:%02d", h, m)}
}
