package sea

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/rules"
	"github.com/jackc/pgx/v5"
)

// QuestView returns the current daily board without persisting a new one. The
// selection is deterministic from the private root seed, so a board that has
// never been written still matches what QuestRefresh would create. Submit
// quests derive their progress from current inventory, like the legacy view.
func (s *Service) QuestView(ctx context.Context, owner int64) (QuestBoard, error) {
	if owner < 1 {
		return QuestBoard{}, assets.ErrInvalid
	}
	seed, err := s.questSeed(ctx, owner)
	if err != nil {
		return QuestBoard{}, err
	}
	var now time.Time
	if err := s.pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return QuestBoard{}, assets.ErrUnavailable
	}
	day := now.Add(-time.Duration(s.catalog.SeaConfig().QuestResetHour) * time.Hour).In(s.location).Format("2006-01-02")
	selected := []Quest{}
	for _, q := range s.catalog.RollSeaQuests(rules.Stream(seed, "sea-quest-day:"+day)) {
		selected = append(selected, Quest{ID: q.ID})
	}
	var storedDay string
	var actual []byte
	err = s.pool.QueryRow(ctx, `SELECT day::text,selected FROM fishing.sea_quest_boards WHERE owner_id=$1`, owner).Scan(&storedDay, &actual)
	switch {
	case err == nil && storedDay == day:
		if json.Unmarshal(actual, &selected) != nil {
			return QuestBoard{}, assets.ErrUnavailable
		}
	case err != nil && !errors.Is(err, pgx.ErrNoRows):
		return QuestBoard{}, assets.ErrUnavailable
	}
	for i := range selected {
		q := &selected[i]
		tpl := s.template(q.ID)
		if tpl.Submit != nil && !q.Claimed {
			have, err := submitHaveRead(ctx, s.pool, owner, tpl.Submit.ID)
			if err != nil {
				return QuestBoard{}, err
			}
			q.Progress = 0
			if have >= tpl.Submit.Count {
				q.Progress = tpl.Need
			}
		}
	}
	return QuestBoard{day, selected}, nil
}

func submitHaveRead(ctx context.Context, q assets.SQL, owner int64, id string) (int64, error) {
	var n int64
	if err := q.QueryRow(ctx, `SELECT COALESCE((SELECT quantity FROM fishing.inventory_stacks WHERE owner_id=$1 AND item_id=$2 AND tier='normal'),0)`, owner, id).Scan(&n); err != nil {
		return 0, assets.ErrUnavailable
	}
	return n, nil
}
