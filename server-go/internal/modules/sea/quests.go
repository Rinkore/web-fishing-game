package sea

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"sort"
	"time"
)

type Quest struct {
	ID       string `json:"id"`
	Progress int64  `json:"progress"`
	Claimed  bool   `json:"claimed"`
}
type QuestBoard struct {
	Day      string  `json:"day"`
	Selected []Quest `json:"selected"`
}

// A durable private player root prevents rerolling with different request keys.
func (s *Service) questSeed(ctx context.Context, owner int64) ([]byte, error) {
	if owner < 1 {
		return nil, assets.ErrInvalid
	}
	seed := make([]byte, 32)
	if _, err := rand.Read(seed); err != nil {
		return nil, assets.ErrUnavailable
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO fishing.sea_quest_roots(owner_id,private_seed) VALUES($1,$2) ON CONFLICT DO NOTHING`, owner, seed); err != nil {
		return nil, assets.ErrUnavailable
	}
	if err := s.pool.QueryRow(ctx, `SELECT private_seed FROM fishing.sea_quest_roots WHERE owner_id=$1`, owner).Scan(&seed); err != nil {
		return nil, assets.ErrUnavailable
	}
	return seed, nil
}
func (s *Service) board(ctx context.Context, t *assets.Transaction, owner int64, seed []byte) (QuestBoard, error) {
	var now time.Time
	if err := t.SQL().QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return QuestBoard{}, err
	}
	day := now.Add(-time.Duration(s.catalog.SeaConfig().QuestResetHour) * time.Hour).In(s.location).Format("2006-01-02")
	selected := []Quest{}
	for _, q := range s.catalog.RollSeaQuests(rules.Stream(seed, "sea-quest-day:"+day)) {
		selected = append(selected, Quest{ID: q.ID})
	}
	data, _ := json.Marshal(selected)
	var actual []byte
	if err := t.SQL().QueryRow(ctx, `INSERT INTO fishing.sea_quest_boards(owner_id,day,selected) VALUES($1,$2::date,$3) ON CONFLICT(owner_id) DO UPDATE SET day=excluded.day,selected=CASE WHEN fishing.sea_quest_boards.day=excluded.day THEN fishing.sea_quest_boards.selected ELSE excluded.selected END RETURNING selected`, owner, day, data).Scan(&actual); err != nil {
		return QuestBoard{}, err
	}
	if err := json.Unmarshal(actual, &selected); err != nil {
		return QuestBoard{}, err
	}
	return QuestBoard{day, selected}, nil
}
func (s *Service) saveBoard(ctx context.Context, t *assets.Transaction, owner int64, b QuestBoard) error {
	data, err := json.Marshal(b.Selected)
	if err != nil {
		return err
	}
	_, err = t.SQL().Exec(ctx, `UPDATE fishing.sea_quest_boards SET selected=$2 WHERE owner_id=$1`, owner, data)
	return err
}
func (s *Service) template(id string) rules.SeaQuest {
	for _, q := range s.catalog.SeaConfig().Quests {
		if q.ID == id {
			return q
		}
	}
	return rules.SeaQuest{}
}
func submitHave(ctx context.Context, t *assets.Transaction, owner int64, id string) (int64, error) {
	var n int64
	err := t.SQL().QueryRow(ctx, `SELECT COALESCE((SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id=$2 AND tier='normal'),0)`, owner, id).Scan(&n)
	return n, err
}
func (s *Service) QuestRefresh(ctx context.Context, owner int64, key string) (assets.Result, error) {
	seed, err := s.questSeed(ctx, owner)
	if err != nil {
		return assets.Result{}, err
	}
	return s.assets.Run(ctx, assets.Command{ActorID: owner, RequestKey: key, Kind: "sea_quests_refresh", RuleVersion: s.catalog.Version + ":" + s.catalog.SourceSHA256, Players: []int64{owner}, Input: struct{}{}}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		b, err := s.board(ctx, t, owner, seed)
		if err != nil {
			return assets.Result{}, err
		}
		for i := range b.Selected {
			q := &b.Selected[i]
			tpl := s.template(q.ID)
			if tpl.Submit != nil && !q.Claimed {
				have, err := submitHave(ctx, t, owner, tpl.Submit.ID)
				if err != nil {
					return assets.Result{}, err
				}
				q.Progress = 0
				if have >= tpl.Submit.Count {
					q.Progress = tpl.Need
				}
			}
		}
		details, _ := json.Marshal(b)
		return assets.Result{Status: "refreshed", Details: details}, nil
	})
}
func (s *Service) bumpQuest(ctx context.Context, t *assets.Transaction, owner int64, seed []byte, kind string, n int64) error {
	b, err := s.board(ctx, t, owner, seed)
	if err != nil {
		return err
	}
	for i := range b.Selected {
		q := &b.Selected[i]
		tpl := s.template(q.ID)
		if !q.Claimed && tpl.Kind == kind {
			q.Progress = min(tpl.Need, q.Progress+n)
		}
	}
	return s.saveBoard(ctx, t, owner, b)
}
func (s *Service) QuestClaim(ctx context.Context, owner int64, key, id string) (assets.Result, error) {
	if len(id) < 1 || len(id) > 128 {
		return assets.Result{}, assets.ErrInvalid
	}
	seed, err := s.questSeed(ctx, owner)
	if err != nil {
		return assets.Result{}, err
	}
	return s.assets.Run(ctx, assets.Command{ActorID: owner, RequestKey: key, Kind: "sea_quest_claim", RuleVersion: s.catalog.Version + ":" + s.catalog.SourceSHA256, Players: []int64{owner}, Input: struct{ ID string }{id}}, func(ctx context.Context, t *assets.Transaction) (assets.Result, error) {
		b, err := s.board(ctx, t, owner, seed)
		if err != nil {
			return assets.Result{}, err
		}
		index := -1
		for i, q := range b.Selected {
			if q.ID == id {
				index = i
				break
			}
		}
		if index < 0 {
			return assets.Result{}, assets.Rejection("quest_not_found")
		}
		q := &b.Selected[index]
		if q.Claimed {
			return assets.Result{}, assets.Rejection("quest_already_claimed")
		}
		tpl := s.template(id)
		if tpl.ID == "" {
			return assets.Result{}, assets.Rejection("quest_not_found")
		}
		if tpl.Submit == nil && q.Progress < tpl.Need {
			return assets.Result{}, assets.Rejection("quest_incomplete")
		}
		quantities := map[string]int64{}
		if tpl.Submit != nil {
			have, err := submitHave(ctx, t, owner, tpl.Submit.ID)
			if err != nil {
				return assets.Result{}, err
			}
			if have < tpl.Submit.Count {
				return assets.Result{}, assets.Rejection("quest_submit_insufficient")
			}
			quantities[tpl.Submit.ID] -= tpl.Submit.Count
			q.Progress = tpl.Need
		}
		for item, n := range tpl.Reward.Items {
			if it, ok := s.catalog.Item(item); n > 0 && ok && it.ExpeditionOnly {
				return assets.Result{}, assets.Rejection("expedition_only_reward")
			}
			quantities[item] += n
		}
		quantities["chartfrag"] += tpl.Reward.Chartfrag
		quantities["deepscale"] += tpl.Reward.Deepscale
		ids := []string{}
		for item, n := range quantities {
			if n != 0 {
				ids = append(ids, item)
			}
		}
		sort.Strings(ids)
		deltas := []assets.StackDelta{}
		for _, item := range ids {
			deltas = append(deltas, assets.StackDelta{ItemID: item, Tier: "normal", Quantity: quantities[item]})
		}
		if len(deltas) > 0 {
			if err := t.Stacks(ctx, owner, deltas); err != nil {
				return assets.Result{}, err
			}
		}
		if tpl.Reward.Coins > 0 {
			if err := t.Coins(ctx, owner, tpl.Reward.Coins); err != nil {
				return assets.Result{}, err
			}
		}
		q.Claimed = true
		if err := s.saveBoard(ctx, t, owner, b); err != nil {
			return assets.Result{}, err
		}
		details, _ := json.Marshal(b)
		return assets.Result{Status: "claimed", ResourceID: id, Details: details}, nil
	})
}
