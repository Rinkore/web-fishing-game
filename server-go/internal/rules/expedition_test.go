package rules

import "testing"

func TestFuelImprovesSmeltWithoutAddingAffix(t *testing.T) {
	c, err := Default()
	if err != nil {
		t.Fatal(err)
	}
	in := SmeltInput{MainID: "line_nylon#epic#spd+4", SubID: "line_nylon#epic#skl+3", MainAffix: "speed", SubAffix: "skill"}
	base, err := c.SmeltPlan(in, c.ComponentConfig(), c.WorkshopConfig())
	if err != nil {
		t.Fatal(err)
	}
	in.Materials = []Material{{ID: "rope", Quantity: 3}}
	fuel, err := c.SmeltPlan(in, c.ComponentConfig(), c.WorkshopConfig())
	if err != nil {
		t.Fatal(err)
	}
	if fuel.Rate <= base.Rate || fuel.ExtraType != "" || fuel.ExtraRate != base.ExtraRate {
		t.Fatalf("fuel changes wrong probabilities: %+v", fuel)
	}
	in.Materials = []Material{{ID: "humus", Quantity: 1}}
	catalyst, err := c.SmeltPlan(in, c.ComponentConfig(), c.WorkshopConfig())
	if err != nil {
		t.Fatal(err)
	}
	in.Materials = append(in.Materials, Material{ID: "rope", Quantity: 2})
	mix, err := c.SmeltPlan(in, c.ComponentConfig(), c.WorkshopConfig())
	if err != nil {
		t.Fatal(err)
	}
	if mix.ExtraRate != catalyst.ExtraRate || mix.ExtraType != "material" || mix.Rate <= catalyst.Rate {
		t.Fatal("fuel incorrectly amplifies catalyst", mix.ExtraRate, catalyst.ExtraRate)
	}
	in.Materials = []Material{{ID: "stardust", Quantity: 1}}
	legacy, err := c.SmeltPlan(in, c.ComponentConfig(), c.WorkshopConfig())
	if err != nil || legacy.ExtraType != "rare" {
		t.Fatal("legacy line lost its historical catalyst pool", err)
	}
	// New ordinary parts use the restricted part pool, unlike legacy gear.
	in.MainID = "gear_line_1#epic#skl+3"
	in.SubID = "gear_line_1#epic#spd+4"
	in.MainAffix, in.SubAffix = "skill", "speed"
	if _, err = c.SmeltPlan(in, c.ComponentConfig(), c.WorkshopConfig()); err == nil {
		t.Fatal("new line acquired illegal rarity affix")
	}
}
