package rules

import "testing"

func TestFuelImprovesSmeltWithoutAddingAffix(t *testing.T) {
	c, err := Default()
	if err != nil {
		t.Fatal(err)
	}
	in := SmeltInput{MainID: "gear_line_1#epic#spd+4", SubID: "gear_line_2#epic#stb+3", MainAffix: "speed", SubAffix: "stability"}
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
	if _, err = c.SmeltPlan(in, c.ComponentConfig(), c.WorkshopConfig()); err == nil {
		t.Fatal("line acquired illegal rarity affix")
	}
}
