package prototype_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/fishing"
	"fishing.local/server/internal/modules/market"
)

func TestAutomaticRequestKeysCannotBeOccupiedByOtherCommands(t *testing.T) {
	a := assets.New(nil)
	m := market.New(nil)
	f := fishing.New(nil)
	ctx := context.Background()
	for _, key := range []string{"fishing:settle:1:1:1", "fishing:native-settle:1:1:1", "market:expire:1"} {
		check := func(err error) {
			t.Helper()
			if !errors.Is(err, assets.ErrInvalid) {
				t.Fatal("ordinary request accepted a reserved key")
			}
		}
		_, err := a.TransferCoins(ctx, assets.Transfer{ActorID: 1, RecipientID: 2, Amount: 1, RequestKey: key})
		check(err)
		_, err = a.ApplyChange(ctx, assets.Change{ActorID: 1, RequestKey: key, RuleVersion: "v1", Reason: "reward", Coins: 1})
		check(err)
		_, err = a.ExchangeAssets(ctx, assets.Exchange{ActorID: 1, RecipientID: 2, RequestKey: key, Coins: 1})
		check(err)
		_, err = a.ChangeRod(ctx, assets.RodCommand{ActorID: 1, RequestKey: key, Action: "stow"})
		check(err)
		_, err = m.List(ctx, market.List{ActorID: 1, RequestKey: key, ItemID: "fish", Tier: "normal", Quantity: 1, Price: 1, Lifetime: time.Hour})
		check(err)
		_, err = m.Close(ctx, market.Close{ActorID: 1, ListingID: 1, RequestKey: key})
		check(err)
		_, err = f.Connection(ctx, fishing.Connection{ActorID: 1, RequestKey: key, Action: "connect"})
		check(err)
		_, err = f.Start(ctx, fishing.Start{ActorID: 1, RequestKey: key, RuleVersion: "v1", ConnectionGeneration: 1})
		check(err)
		_, err = f.Stop(ctx, fishing.Stop{ActorID: 1, RequestKey: key, Generation: 1})
		check(err)
	}
}
