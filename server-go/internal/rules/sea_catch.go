package rules

// Sea events preserve the two independent legacy rolls, including the second
// roll consumed after a whirlpool win, and component/size draws before a loss.
type SeaEvents struct {
	Storm        float64 `json:"storm"`
	Whirlpool    float64 `json:"whirlpool"`
	Bounty       float64 `json:"bounty"`
	BountyDouble float64 `json:"bountyDouble"`
	School       float64 `json:"school"`
	Wreck        float64 `json:"wreck"`
}
type SeaCatch struct {
	Lost       bool
	Event      string
	Copies     int
	Chartfrags int64
	Scales     int64
}

func (c *Catalog) SeaCatch(partyCount int, rng RNG) SeaCatch {
	e := c.SeaConfig().Events
	r := rng() * 100
	if r < e.Storm {
		return SeaCatch{Lost: true, Event: "storm"}
	}
	whirl := false
	if r < e.Storm+e.Whirlpool {
		if rng()*100 < 50 {
			return SeaCatch{Lost: true, Event: "whirlpool_loss"}
		}
		whirl = true
	}
	r = rng() * 100
	if whirl {
		return SeaCatch{Event: "whirlpool", Copies: 2}
	}
	school := e.School
	copies := 1
	if partyCount >= 2 {
		school *= 2
		copies++
	}
	if r < e.Bounty {
		n := int64(1)
		if rng()*100 < e.BountyDouble {
			n++
		}
		return SeaCatch{Event: "bounty", Chartfrags: n}
	}
	if r < e.Bounty+school {
		return SeaCatch{Event: "school", Copies: copies}
	}
	if r < e.Bounty+school+e.Wreck {
		return SeaCatch{Event: "wreck", Chartfrags: 1, Scales: 2}
	}
	return SeaCatch{}
}
