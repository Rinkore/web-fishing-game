package rules

import (
	_ "embed"
	"encoding/json"
	"errors"
)

//go:embed catalog.json
var defaultCatalog []byte

type Item struct {
	ID     string       `json:"id"`
	Name   string       `json:"name"`
	Rarity string       `json:"rarity"`
	Kind   string       `json:"kind"`
	Part   string       `json:"part"`
	Price  float64      `json:"price"`
	Size   []float64    `json:"size"`
	Pool   []AffixRange `json:"pool"`
}
type AffixRange struct {
	Type string  `json:"type"`
	Min  float64 `json:"min"`
	Max  float64 `json:"max"`
}
type Catalog struct {
	Format       int                        `json:"format"`
	Version      string                     `json:"version"`
	SourceSHA256 string                     `json:"sourceSHA256"`
	Constants    map[string]json.RawMessage `json:"constants"`
	Defaults     map[string]json.RawMessage `json:"defaults"`
	Items        []Item                     `json:"items"`
	index        map[string]Item
	fishTiers    map[string]string
}

// Default returns an independent value; callers cannot mutate another version's configuration.
func Default() (*Catalog, error) { return DecodeCatalog(defaultCatalog) }
func DecodeCatalog(data []byte) (*Catalog, error) {
	var c Catalog
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	if c.Format != 1 || c.Version == "" || len(c.SourceSHA256) != 64 || len(c.Items) == 0 {
		return nil, errors.New("invalid catalog metadata")
	}
	c.index = map[string]Item{}
	c.fishTiers = map[string]string{}
	var fish map[string][]struct {
		ID string `json:"id"`
	}
	if err := c.Constant("FISH", &fish); err != nil {
		return nil, errors.New("missing fish catalog")
	}
	for tier, items := range fish {
		for _, it := range items {
			c.fishTiers[it.ID] = tier
		}
	}
	for _, it := range c.Items {
		if it.ID == "" || !finite(it.Price) || it.Price < 0 {
			return nil, errors.New("invalid item")
		}
		if _, ok := c.index[it.ID]; ok {
			return nil, errors.New("duplicate item")
		}
		copy := it
		copy.Pool = append([]AffixRange(nil), it.Pool...)
		copy.Size = append([]float64(nil), it.Size...)
		c.index[it.ID] = copy
	}
	return &c, nil
}
func (c *Catalog) Item(id string) (Item, bool) {
	it, ok := c.index[id]
	it.Pool = append([]AffixRange(nil), it.Pool...)
	it.Size = append([]float64(nil), it.Size...)
	return it, ok
}
func (c *Catalog) Constant(name string, out any) error { return json.Unmarshal(c.Constants[name], out) }
