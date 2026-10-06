package breeding

import (
	"fmt"
	"testing"
)

func TestReferenceFounderIsExactHomozygousPhenotype(t *testing.T) {
	fish, err := Founder("koi", "giant")
	if err != nil {
		t.Fatal(err)
	}
	if !Valid(fish) || len(fish.Genes) != len(Catalog.Loci)+len(mutationLoci)+len(colorLoci)+len(ornamentLoci)+1 {
		t.Fatalf("invalid founder: %#v", fish)
	}
	phenotype, err := Express(fish)
	if err != nil {
		t.Fatal(err)
	}
	if phenotype.Body != "koi" || phenotype.Size != "giant" || !phenotype.ReferenceExact {
		t.Fatalf("founder drifted from reference: %#v", phenotype)
	}
	if phenotype.ReferenceSHA256 != Catalog.Species["koi"].SHA256 {
		t.Fatal("founder reference digest was not retained")
	}
	for _, locus := range Catalog.Loci {
		expression := phenotype.Traits[locus]
		if expression.Alleles != [2]string{"koi", "koi"} || expression.Source != "koi" || expression.Hidden {
			t.Fatalf("founder locus %s drifted: %#v", locus, expression)
		}
	}
}

func TestPairingUsesConservativeRealWorldGroups(t *testing.T) {
	for _, nonFish := range []string{"dragonpearl", "pearl", "squid", "amberlobster"} {
		if _, err := Founder(nonFish); err == nil {
			t.Fatalf("%s is not a fish breeding parent", nonFish)
		}
	}
	carp, _ := Founder("carp")
	koi, _ := Founder("koi")
	crucian, _ := Founder("crucian")
	moonkoi, _ := Founder("moonkoi")
	bighead, _ := Founder("bighead")
	silver, _ := Founder("silvercarp")
	bass, _ := Founder("bass")
	for i, fish := range []*Fish{&carp, &koi, &crucian, &moonkoi, &bighead, &silver, &bass} {
		fish.ID = string(rune('a' + i))
	}
	if !CanPair(carp, koi) || !CanPair(carp, crucian) || !CanPair(bighead, silver) || !CanPair(koi, moonkoi) {
		t.Fatal("documented hybrid groups should pair")
	}
	if CanPair(carp, bass) || CanPair(bighead, carp) || CanPair(carp, moonkoi) {
		t.Fatal("unlisted cross-species pair was accepted")
	}
	if _, err := Breed(carp, bass, []byte("incompatible")); err == nil {
		t.Fatal("unlisted cross-species breeding should be rejected")
	}
}

func TestOrnamentalCarpTraitsAndExactFounders(t *testing.T) {
	gold, _ := Founder("koi")
	moon, _ := Founder("moonkoi")
	gold.ID = "gold"
	moon.ID = "moon"
	for _, parent := range []Fish{gold, moon} {
		p, err := Express(parent)
		if err != nil || !p.ReferenceExact {
			t.Fatalf("reference founder altered: %#v %v", p, err)
		}
	}
	child, err := Breed(gold, moon, []byte("gold-moon"))
	if err != nil {
		t.Fatal(err)
	}
	p, err := Express(child)
	if err != nil {
		t.Fatal(err)
	}
	if child.Genes["goldscale"] != [2]string{"K", "k"} || child.Genes["moonlight"] != [2]string{"M", "m"} {
		t.Fatalf("ornamental inheritance: %#v", child.Genes)
	}
	if !p.Ornaments["goldscale"] || p.Ornaments["moonlight"] || !p.Traits["moonlight"].Hidden {
		t.Fatalf("dominance/carrier wrong: %#v", p)
	}
	moon.Genes["moonlight"] = [2]string{"M", "m"}
	gold.Genes["goldscale"] = [2]string{"k", "k"}
	for _, segregated := range []Fish{moon, gold} {
		p, err := Express(segregated)
		if err != nil || p.ReferenceExact || p.Ornaments["goldscale"] || p.Ornaments["moonlight"] {
			t.Fatalf("reference sprite bypassed hidden/lost ornamental gene: %#v %v", p, err)
		}
	}
}

func TestGenerationsContinueBeyondThree(t *testing.T) {
	a, _ := Founder("koi")
	b, _ := Founder("koi")
	a.ID, b.ID = "a", "b"
	child, err := Breed(a, b, []byte("generation-one"))
	if err != nil || child.Generation != 1 {
		t.Fatalf("child: %#v %v", child, err)
	}
	child.ID = "c"
	grandchild, err := Breed(child, a, []byte("generation-two"))
	if err != nil || grandchild.Generation != 2 {
		t.Fatalf("grandchild: %#v %v", grandchild, err)
	}
	grandchild.ID = "d"
	third, err := Breed(grandchild, a, []byte("generation-three"))
	if err != nil || third.Generation != 3 {
		t.Fatalf("third generation: %#v %v", third, err)
	}
	parent := third
	for generation := 4; generation <= 12; generation++ {
		parent.ID = fmt.Sprintf("g%d", generation-1)
		child, breedErr := Breed(parent, a, []byte(fmt.Sprintf("generation-%d", generation)))
		if breedErr != nil || child.Generation != generation || !Valid(child) {
			t.Fatalf("generation %d: %#v %v", generation, child, breedErr)
		}
		parent = child
	}
}

func TestFiveHiddenColourLociAndDirectedAllele(t *testing.T) {
	a, _ := Founder("koi")
	b, _ := Founder("koi")
	a.ID, b.ID = "a", "b"
	for _, locus := range colorLoci {
		child, err := Breed(a, b, []byte("direct-"+locus), locus)
		if err != nil || !Valid(child) {
			t.Fatalf("%s: %#v %v", locus, child, err)
		}
		m := Catalog.Colors[locus]
		pair := child.Genes[locus]
		if pair[0] != m.Allele && pair[1] != m.Allele {
			t.Fatalf("%s was not directed: %#v", locus, pair)
		}
		phenotype, expressErr := Express(child)
		if expressErr != nil {
			t.Fatal(expressErr)
		}
		if !phenotype.Traits[locus].Hidden || phenotype.Colors[locus] {
			t.Fatalf("%s did not remain latent: %#v", locus, phenotype.Traits[locus])
		}
	}
	legacy := a
	legacy.Genes = Genome{}
	for locus, pair := range a.Genes {
		if _, color := Catalog.Colors[locus]; !color {
			legacy.Genes[locus] = pair
		}
	}
	if !Valid(legacy) {
		t.Fatal("pre-v3 genome became invalid")
	}
	child, err := Breed(legacy, b, []byte("legacy"))
	if err != nil || !Valid(child) || len(child.Genes) != len(a.Genes) {
		t.Fatalf("legacy inheritance: %#v %v", child, err)
	}
}

func TestWhitePixelRepairKeepsExistingFoundersValid(t *testing.T) {
	for id, historical := range legacyReferenceSHA {
		fish, err := Founder(id)
		if err != nil {
			t.Fatal(err)
		}
		fish.ReferenceSHA256 = historical
		if !Valid(fish) {
			t.Fatalf("%s historical genome rejected", id)
		}
		phenotype, err := Express(fish)
		if err != nil || phenotype.ReferenceSHA256 != Catalog.Species[id].SHA256 {
			t.Fatalf("%s did not display repaired source: %#v %v", id, phenotype, err)
		}
	}
}

func TestDominantRecessiveAndBodyCompatibilityStayVisible(t *testing.T) {
	fish, _ := Founder("koi")
	fish.Genes["albino"] = [2]string{"a", "A"}
	phenotype, err := Express(fish)
	if err != nil {
		t.Fatal(err)
	}
	albino := phenotype.Traits["albino"]
	if !albino.Hidden || !albino.Carrier || albino.Zygosity != "heterozygous" || phenotype.Mutations["albino"] {
		t.Fatalf("recessive carrier is not distinguishable: %#v", albino)
	}

	// Force a donor head whose architecture does not fit the koi body. The
	// allele stays inspectable, while expression falls back to the body source.
	fish.Genes["head"] = [2]string{"ghostray", "ghostray"}
	// This synthetic combination bypasses Valid's breeding-line guard, so test
	// the compatibility rule directly rather than constructing impossible DNA.
	if anatomyCompatible(Catalog.Species["koi"], Catalog.Species["ghostray"], "head") {
		t.Fatal("ray head should not express on a streamlined body")
	}
}

func TestBreedCanCreateAndExpressMutation(t *testing.T) {
	a, _ := Founder("koi")
	b, _ := Founder("koi")
	a.ID, b.ID = "a", "b"
	for i := 0; i < 10000; i++ {
		child, err := Breed(a, b, []byte(fmt.Sprintf("mutation-seed-%d", i)))
		if err != nil {
			t.Fatal(err)
		}
		if len(child.Mutations) == 0 {
			continue
		}
		phenotype, expressErr := Express(child)
		if expressErr != nil {
			t.Fatal(expressErr)
		}
		for _, locus := range child.Mutations {
			if _, exists := phenotype.Traits[locus]; !exists {
				t.Fatalf("new mutation %s missing from phenotype", locus)
			}
		}
		return
	}
	t.Fatal("no mutation produced across deterministic seed search")
}
