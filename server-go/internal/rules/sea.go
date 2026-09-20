package rules

import "strconv"

type SeaConfig struct {
	ChartCost      int64      `json:"chartCost"`
	ZoneTTL        int64      `json:"zoneTtlMs"`
	ZoneMax        int        `json:"zoneMax"`
	Names          []string   `json:"names"`
	SpotNames      []string   `json:"spotNames"`
	Moods          []SeaMood  `json:"moods"`
	QuestResetHour int        `json:"questResetHour"`
	Quests         []SeaQuest `json:"quests"`
	Anchor         struct {
		Coins     int64     `json:"coins"`
		Scales    int64     `json:"scales"`
		MaxTimes  int       `json:"maxTimes"`
		ExtendMin int64     `json:"extendMin"`
		Buffs     []SeaBuff `json:"buffs"`
	} `json:"anchor"`
}
type SeaBuff struct {
	Type  string  `json:"type"`
	Value float64 `json:"value"`
}
type SeaMood struct {
	ID       string    `json:"id"`
	Weight   float64   `json:"w"`
	RareBias float64   `json:"rareBias"`
	Buffs    []SeaBuff `json:"buffs"`
}
type SeaSpot struct {
	ID    string      `json:"id"`
	Name  string      `json:"name"`
	Pool  []LootEntry `json:"pool"`
	Buffs []SeaBuff   `json:"buffs"`
}
type SeaZone struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	Mood    string    `json:"mood"`
	Expire  int64     `json:"expire"`
	Spots   []SeaSpot `json:"spots"`
	Anchors int       `json:"anchors,omitempty"`
}
type SeaQuest struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Kind   string `json:"kind"`
	Need   int64  `json:"need"`
	Submit *struct {
		ID    string `json:"id"`
		Count int64  `json:"count"`
	} `json:"submit"`
	Reward struct {
		Coins     int64            `json:"coins"`
		Chartfrag int64            `json:"chartfrag"`
		Deepscale int64            `json:"deepscale"`
		Items     map[string]int64 `json:"items"`
	} `json:"reward"`
}

func (c *Catalog) SeaConfig() SeaConfig { var cfg SeaConfig; _ = c.Constant("SEA", &cfg); return cfg }

var seaFishTemplate = []LootEntry{{"fish:mullet", 20, nil}, {"fish:jackmack", 18, nil}, {"fish:squid", 13, nil}, {"fish:octo", 9, nil}, {"fish:sardine", 12, nil}, {"fish:croaker", 10, nil}, {"fish:seabass", 6, nil}, {"fish:mackerel", 7, nil}, {"fish:tuna", 5, nil}, {"fish:mahimahi", 5, nil}, {"fish:amberjack", 5, nil}, {"fish:halibut", 4, nil}, {"fish:giantquid", 4, nil}, {"fish:cobia", 3, nil}, {"fish:sunfish", 3, nil}, {"fish:bluefin", 2, nil}, {"fish:coelacanth", 2, nil}, {"fish:megamouth", 1, nil}, {"fish:leviathan", 1, nil}}

// v0.21.4 uses Array.sort with an inconsistent random comparator. For this
// fixed 19-element input, V8 uses run detection plus stable binary insertion.
// Preserve that biased draw order; do not silently replace it with a shuffle.
func legacySeaSort(rng RNG) []LootEntry {
	a := append([]LootEntry(nil), seaFishTemplate...)
	run := 2
	descending := rng() < .5
	for run < len(a) {
		less := rng() < .5
		if less != descending {
			break
		}
		run++
	}
	if descending {
		for i, j := 0, run-1; i < j; i, j = i+1, j-1 {
			a[i], a[j] = a[j], a[i]
		}
	}
	for start := run; start < len(a); start++ {
		pivot := a[start]
		left, right := 0, start
		for left < right {
			mid := left + (right-left)/2
			if rng() < .5 {
				right = mid
			} else {
				left = mid + 1
			}
		}
		copy(a[left+1:start+1], a[left:start])
		a[left] = pivot
	}
	return a
}
func (c *Catalog) VoyageZone(nowMS int64, rng RNG) SeaZone {
	cfg := c.SeaConfig()
	total := 0.0
	for _, m := range cfg.Moods {
		total += m.Weight
	}
	draw := rng() * total
	mood := cfg.Moods[1]
	for _, m := range cfg.Moods {
		draw -= m.Weight
		if draw <= 0 {
			mood = m
			break
		}
	}
	name := cfg.Names[int(rng()*float64(len(cfg.Names)))]
	names := append([]string(nil), cfg.SpotNames...)
	chosen := []string{}
	for i := 0; i < 2 && len(names) > 0; i++ {
		index := int(rng() * float64(len(names)))
		chosen = append(chosen, names[index])
		names = append(names[:index], names[index+1:]...)
	}
	for len(chosen) < 2 {
		chosen = append(chosen, []string{"渔场·甲", "渔场·乙"}[len(chosen)])
	}
	z := SeaZone{Name: name, Mood: mood.ID, Expire: nowMS + cfg.ZoneTTL, Spots: []SeaSpot{}}
	for i := 0; i < 2; i++ {
		pool := legacySeaSort(rng)
		pool = pool[:5+int(rng()*3)]
		for j := range pool {
			if c.fishTiers[pool[j].Pick[5:]] == "rare" {
				pool[j].Weight *= mood.RareBias
			}
		}
		pool = append(pool, LootEntry{Pick: "material:chartfrag", Weight: 2}, LootEntry{Pick: "component", Weight: 6})
		z.Spots = append(z.Spots, SeaSpot{ID: "z" + strconv.Itoa(i+1), Name: chosen[i], Pool: pool, Buffs: append([]SeaBuff(nil), mood.Buffs...)})
	}
	z.ID = "z" + strconv.FormatInt(nowMS, 36) + strconv.FormatInt(int64(rng()*46656), 36)
	return z
}
func (c *Catalog) RollSeaQuests(rng RNG) []SeaQuest {
	pool := c.SeaConfig().Quests
	out := []SeaQuest{}
	for len(out) < 3 && len(pool) > 0 {
		i := int(rng() * float64(len(pool)))
		out = append(out, pool[i])
		pool = append(pool[:i], pool[i+1:]...)
	}
	return out
}
