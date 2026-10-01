package rules

import (
	"encoding/json"
)

type WorkshopConfig struct {
	BaseRate             float64                         `json:"baseRate"`
	FailPerMaterial      float64                         `json:"failPerMaterial"`
	ExtraRatePerMaterial float64                         `json:"extraRatePerMaterial"`
	ExtraRatePearl       float64                         `json:"extraRatePearl"`
	ExtraRateMax         float64                         `json:"extraRateMax"`
	RateMin              float64                         `json:"rateMin"`
	RateMax              float64                         `json:"rateMax"`
	GoldBase             float64                         `json:"goldBase"`
	GoldPerMaterial      float64                         `json:"goldPerMaterial"`
	GoldPearl            float64                         `json:"goldPearl"`
	MaxMaterials         int                             `json:"maxMaterials"`
	MaxTypes             int                             `json:"maxTypes"`
	PearlRollTwice       bool                            `json:"pearlRollTwice"`
	RecastPearl          int                             `json:"recastPearl"`
	RecastGold           float64                         `json:"recastGold"`
	RecastMinValue       int                             `json:"recastMinValue"`
	RetainFormula        string                          `json:"retainFormula"`
	RetainMaxRelic       int                             `json:"retainMaxRelic"`
	SubRangeFromSub      bool                            `json:"subRangeFromSub"`
	AddAnyAffix          bool                            `json:"addAnyAffix"`
	AddAffixCap          int                             `json:"addAffixCap"`
	AddAffixExtraRange   bool                            `json:"addAffixExtraRange"`
	CatalystRanges       map[string]map[string][]float64 `json:"catalystRanges"`
	CatalystRatio        float64                         `json:"catalystRatio"`
	ForgeAnyAffix        bool                            `json:"forgeAnyAffix"`
}

func (c *Catalog) WorkshopConfig() WorkshopConfig {
	var cfg WorkshopConfig
	_ = json.Unmarshal(c.Defaults["smelt"], &cfg)
	return cfg
}
