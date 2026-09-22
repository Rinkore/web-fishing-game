package operations

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"sort"
	"time"
)

// Server heat-map sampling and reporting for the operator console.
//
// The original server sampled online/fishing/listing/trade/account counts every
// 60 seconds into memory (24 hours of minute samples, 30 days of hourly
// aggregates) and persisted them with the world state. The Go side stores the
// minute samples durably and aggregates them in SQL, so the console keeps its
// history across a restart.

// Sample is one point-in-time projection of the server. Grounds and spots count
// the players currently fishing per ground id and per "ground:spot" key.
type Sample struct {
	Online   int64            `json:"online"`
	Fishing  int64            `json:"fishing"`
	Listings int64            `json:"listings"`
	Trades   int64            `json:"trades"`
	Players  int64            `json:"players"`
	Grounds  map[string]int64 `json:"grounds"`
	Spots    map[string]int64 `json:"spots"`
}

func (s *Service) LiveSample(ctx context.Context) (Sample, error) {
	sample := Sample{Grounds: map[string]int64{}, Spots: map[string]int64{}}
	err := s.pool.QueryRow(ctx, `SELECT
 (SELECT count(DISTINCT owner_id) FROM fishing.gateway_streams WHERE expires_at>clock_timestamp()),
 (SELECT count(*) FROM fishing.native_fishing_sessions WHERE state='active'),
 (SELECT count(*) FROM fishing.market_orders WHERE state='open'),
 (SELECT count(*) FROM fishing.trades WHERE state IN ('invited','accepted')),
 (SELECT count(*) FROM fishing.identities WHERE NOT retired)`).
		Scan(&sample.Online, &sample.Fishing, &sample.Listings, &sample.Trades, &sample.Players)
	if err != nil {
		return sample, err
	}
	rows, err := s.pool.Query(ctx, `SELECT ground_id,count(*) FROM fishing.native_fishing_sessions WHERE state='active' GROUP BY ground_id`)
	if err != nil {
		return sample, err
	}
	for rows.Next() {
		var ground string
		var count int64
		if err := rows.Scan(&ground, &count); err != nil {
			rows.Close()
			return sample, err
		}
		sample.Grounds[ground] = count
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return sample, err
	}
	rows, err = s.pool.Query(ctx, `SELECT ground_id,spot_id,count(*) FROM fishing.native_fishing_sessions WHERE state='active' GROUP BY ground_id,spot_id`)
	if err != nil {
		return sample, err
	}
	for rows.Next() {
		var ground, spot string
		var count int64
		if err := rows.Scan(&ground, &spot, &count); err != nil {
			rows.Close()
			return sample, err
		}
		sample.Spots[ground+":"+spot] = count
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return sample, err
	}
	return sample, nil
}

// SampleOnce records one minute bucket. The bucket is the primary key, so a
// restart or a second process inside the same minute cannot double count.
func (s *Service) SampleOnce(ctx context.Context, at time.Time) error {
	sample, err := s.LiveSample(ctx)
	if err != nil {
		return err
	}
	grounds, err := json.Marshal(sample.Grounds)
	if err != nil {
		return err
	}
	spots, err := json.Marshal(sample.Spots)
	if err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO fishing.activity_samples(sampled_at,online,fishing,listings,trades,players,grounds,spots)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(sampled_at) DO NOTHING`,
		at.Truncate(time.Minute), sample.Online, sample.Fishing, sample.Listings, sample.Trades, sample.Players, grounds, spots); err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `DELETE FROM fishing.activity_samples WHERE sampled_at<clock_timestamp()-interval '30 days'`)
	return err
}

func (s *Service) RunStatsSampler(ctx context.Context, logger *slog.Logger) {
	tick := func() {
		work, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		// The original sampled at startup so a restarted server has a right edge
		// on the curve instead of an empty chart.
		if err := s.SampleOnce(work, time.Now()); err != nil && ctx.Err() == nil {
			logger.Error("stats_sample_failed", "error", err.Error())
		}
	}
	tick()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			tick()
		}
	}
}

type StatsFilter struct {
	Ground string
	Spot   string
}

type StatsPoint struct {
	T         int64    `json:"t"`
	N         int64    `json:"n"`
	Online    float64  `json:"online"`
	OnlineMax int64    `json:"onlineMax"`
	Fishing   float64  `json:"fishing"`
	Listings  float64  `json:"listings"`
	Trades    float64  `json:"trades"`
	Users     int64    `json:"users"`
	Area      *float64 `json:"area"`
}

type StatsReport struct {
	Range    string       `json:"range"`
	Step     int64        `json:"step"`
	Span     int64        `json:"span"`
	From     int64        `json:"from"`
	Now      int64        `json:"now"`
	Points   []StatsPoint `json:"points"`
	Heat     [][]*float64 `json:"heat"`
	HeatN    [][]int64    `json:"heatN"`
	HeatMax  float64      `json:"heatMax"`
	HeatDays int64        `json:"heatDays"`
	Peak     struct {
		Online int64 `json:"online"`
		T      int64 `json:"t"`
	} `json:"peak"`
	Live    Sample `json:"live"`
	Samples struct {
		Min  int64 `json:"min"`
		Hour int64 `json:"hour"`
	} `json:"samples"`
}

var statsRanges = map[string]struct {
	Span time.Duration
	Step time.Duration
}{
	"1h":  {time.Hour, time.Minute},
	"6h":  {6 * time.Hour, 5 * time.Minute},
	"24h": {24 * time.Hour, 10 * time.Minute},
	"7d":  {7 * 24 * time.Hour, time.Hour},
	"30d": {30 * 24 * time.Hour, 6 * time.Hour},
}

const statsHeatDays = 28

// accumulator mirrors the original put(): every sample inside a bucket is summed
// and the bucket reports averages plus the highest online reading.
type accumulator struct {
	t                      int64
	n                      int64
	onlineSum, fishingSum  float64
	listingsSum, tradesSum float64
	onlineMax              int64
	users                  int64
	areaSum                float64
	areaN                  int64
}

func (a *accumulator) put(sample Sample, area *int64) {
	a.n++
	a.onlineSum += float64(sample.Online)
	if sample.Online > a.onlineMax {
		a.onlineMax = sample.Online
	}
	a.fishingSum += float64(sample.Fishing)
	a.listingsSum += float64(sample.Listings)
	a.tradesSum += float64(sample.Trades)
	a.users = sample.Players
	if area != nil {
		a.areaSum += float64(*area)
		a.areaN++
	}
}

func (a *accumulator) point(filtered bool) StatsPoint {
	out := StatsPoint{T: a.t, N: a.n, OnlineMax: a.onlineMax, Users: a.users}
	if a.n > 0 {
		out.Online = round1(a.onlineSum / float64(a.n))
		out.Fishing = round1(a.fishingSum / float64(a.n))
		out.Listings = round1(a.listingsSum / float64(a.n))
		out.Trades = round1(a.tradesSum / float64(a.n))
	}
	if filtered {
		value := 0.0
		if a.areaN > 0 {
			value = round1(a.areaSum / float64(a.areaN))
		}
		out.Area = &value
	}
	return out
}

// StatsReport mirrors the original statsReport(): a bucketed curve, a
// weekday-by-hour heat grid over the last 28 days, and the live point appended
// so the curve always reaches "now". offset is the server's UTC offset as an
// interval ("+08:00") used to place samples on the local weekday/hour grid.
func (s *Service) StatsReport(ctx context.Context, key string, filter StatsFilter, offset string) (StatsReport, error) {
	r, known := statsRanges[key]
	if !known {
		key, r = "24h", statsRanges["24h"]
	}
	now := time.Now()
	report := StatsReport{Range: key, Step: int64(r.Step / time.Millisecond), Span: int64(r.Span / time.Millisecond), Now: now.UnixMilli()}
	report.From = now.Add(-r.Span).UnixMilli()
	report.HeatDays = statsHeatDays
	report.Points = []StatsPoint{}
	report.Heat = make([][]*float64, 7)
	report.HeatN = make([][]int64, 7)
	for i := range report.Heat {
		report.Heat[i] = make([]*float64, 24)
		report.HeatN[i] = make([]int64, 24)
	}
	// The area series reads the per-sample ground/spot counters. The parameter
	// placeholder differs between the two queries, so build the expression per
	// call site.
	areaKey := ""
	areaExpr := func(placeholder string) string { return "" }
	switch {
	case filter.Spot != "":
		areaKey = filter.Spot
		areaExpr = func(placeholder string) string { return "COALESCE((spots->>" + placeholder + ")::numeric,0)" }
	case filter.Ground != "":
		areaKey = filter.Ground
		areaExpr = func(placeholder string) string { return "COALESCE((grounds->>" + placeholder + ")::numeric,0)" }
	}

	buckets := map[int64]*accumulator{}
	order := []int64{}
	bucketOf := func(t int64) *accumulator {
		bucket := t / report.Step * report.Step
		entry, ok := buckets[bucket]
		if !ok {
			entry = &accumulator{t: bucket}
			buckets[bucket] = entry
			order = append(order, bucket)
		}
		return entry
	}

	query := `SELECT (floor(extract(epoch FROM sampled_at)*1000/$2)::bigint*$2),count(*),avg(online),max(online),avg(fishing),avg(listings),avg(trades),
 (array_agg(players ORDER BY sampled_at DESC))[1]`
	if areaKey == "" {
		query += ` FROM fishing.activity_samples WHERE sampled_at>=to_timestamp($1::double precision/1000.0) GROUP BY 1 ORDER BY 1`
	} else {
		query += `,avg(` + areaExpr("$3") + `) FROM fishing.activity_samples WHERE sampled_at>=to_timestamp($1::double precision/1000.0) GROUP BY 1 ORDER BY 1`
	}
	args := []any{report.From, report.Step}
	if areaKey != "" {
		args = append(args, areaKey)
	}
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return report, err
	}
	for rows.Next() {
		var t, n, onlineMax, users int64
		var online, fishing, listings, trades float64
		values := []any{&t, &n, &online, &onlineMax, &fishing, &listings, &trades, &users}
		var area *float64
		if areaKey != "" {
			values = append(values, &area)
		}
		if err := rows.Scan(values...); err != nil {
			rows.Close()
			return report, err
		}
		entry := &accumulator{t: t, n: n, users: users, onlineMax: onlineMax,
			onlineSum: online * float64(n), fishingSum: fishing * float64(n),
			listingsSum: listings * float64(n), tradesSum: trades * float64(n)}
		if area != nil {
			entry.areaSum, entry.areaN = *area*float64(n), n
		}
		buckets[t] = entry
		order = append(order, t)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return report, err
	}

	heatQuery := `SELECT extract(isodow FROM sampled_at AT TIME ZONE $1::interval)::int,extract(hour FROM sampled_at AT TIME ZONE $1::interval)::int,avg(`
	if areaKey == "" {
		heatQuery += `online),count(*) FROM fishing.activity_samples WHERE sampled_at>=clock_timestamp()-interval '28 days' GROUP BY 1,2`
	} else {
		heatQuery += areaExpr("$2") + `),count(*) FROM fishing.activity_samples WHERE sampled_at>=clock_timestamp()-interval '28 days' GROUP BY 1,2`
	}
	heatArgs := []any{offset}
	if areaKey != "" {
		heatArgs = append(heatArgs, areaKey)
	}
	heatRows, err := s.pool.Query(ctx, heatQuery, heatArgs...)
	if err != nil {
		return report, err
	}
	for heatRows.Next() {
		var weekday, hour, count int
		var value float64
		if err := heatRows.Scan(&weekday, &hour, &value, &count); err != nil {
			heatRows.Close()
			return report, err
		}
		if weekday < 1 || weekday > 7 || hour < 0 || hour > 23 {
			continue
		}
		rounded := round1(value)
		report.Heat[weekday-1][hour] = &rounded
		report.HeatN[weekday-1][hour] = int64(count)
		if rounded > report.HeatMax {
			report.HeatMax = rounded
		}
	}
	err = heatRows.Err()
	heatRows.Close()
	if err != nil {
		return report, err
	}

	if err := s.pool.QueryRow(ctx, `SELECT online,(extract(epoch FROM sampled_at)*1000)::bigint FROM fishing.activity_samples ORDER BY online DESC,sampled_at LIMIT 1`).
		Scan(&report.Peak.Online, &report.Peak.T); err != nil {
		report.Peak.Online, report.Peak.T = 0, 0
	}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE sampled_at>=clock_timestamp()-interval '24 hours'),
 count(DISTINCT date_trunc('hour',sampled_at)) FROM fishing.activity_samples WHERE sampled_at>=clock_timestamp()-interval '30 days'`).
		Scan(&report.Samples.Min, &report.Samples.Hour); err != nil {
		return report, err
	}

	live, err := s.LiveSample(ctx)
	if err != nil {
		return report, err
	}
	report.Live = live
	var liveArea *int64
	if areaKey != "" {
		count := int64(0)
		if filter.Spot != "" {
			count = live.Spots[filter.Spot]
		} else {
			count = live.Grounds[filter.Ground]
		}
		liveArea = &count
	}
	bucketOf(now.Truncate(time.Minute).UnixMilli()).put(live, liveArea)

	sort.Slice(order, func(i, j int) bool { return order[i] < order[j] })
	filtered := areaKey != ""
	for _, bucket := range order {
		report.Points = append(report.Points, buckets[bucket].point(filtered))
	}
	return report, nil
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }
