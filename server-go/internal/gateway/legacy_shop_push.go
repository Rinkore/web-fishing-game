package gateway

import (
	"context"
	"sync"
	"time"

	"fishing.local/server/internal/modules/economy"
	"fishing.local/server/internal/rules"
)

func (a *API) legacyShopData(ctx context.Context, c *rules.Catalog) (map[string]any, error) {
	prices, err := economy.New(a.pool, c).Prices(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	for _, p := range prices {
		out[p.ID] = map[string]any{"base": p.Base, "price": p.Price, "soldToday": p.SoldToday, "soldTotal": p.SoldTotal}
	}
	return out, nil
}

// The shared cache bounds price-board SQL work to one read per second and
// immutable catalog version. HTTP purchases and quotes always read authority.
type legacyShopCache struct {
	mu     sync.Mutex
	digest string
	at     time.Time
	data   map[string]any
}

func (a *API) legacyShopForStream(ctx context.Context, c *rules.Catalog) (map[string]any, error) {
	cache := &a.shopCache
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	digest := c.Version + ":" + c.SourceSHA256
	if cache.data != nil && cache.digest == digest && time.Since(cache.at) < time.Second {
		return cache.data, nil
	}
	data, err := a.legacyShopData(ctx, c)
	if err != nil {
		return nil, err
	}
	cache.data, cache.at, cache.digest = data, time.Now(), digest
	return data, nil
}

type legacyShopPush struct {
	api     *API
	catalog *rules.Catalog
	last    string
}

func (p *legacyShopPush) init(ctx context.Context) map[string]any {
	data, err := p.api.legacyShopForStream(ctx, p.catalog)
	if err != nil {
		return nil
	}
	p.last = jsonString(data)
	return map[string]any{"shop": data}
}

func (p *legacyShopPush) poll(ctx context.Context) []string {
	data, err := p.api.legacyShopForStream(ctx, p.catalog)
	if err != nil {
		return nil
	}
	next := jsonString(data)
	if next == p.last {
		return nil
	}
	p.last = next
	return []string{legacyFrame(map[string]any{"type": "shop", "shop": data})}
}
