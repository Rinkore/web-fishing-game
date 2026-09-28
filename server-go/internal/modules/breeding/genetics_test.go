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
	if !Valid(fish) || len(fish.Genes) != len(Catalog.Loci)+len(mutationLoci)+1 {
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
	if !CanPair(carp, koi) || !CanPair(carp, crucian) || !CanPair(bighead, silver) {
		t.Fatal("documented hybrid groups should pair")
	}
	if CanPair(carp, bass) || CanPair(bighead, carp) || CanPair(carp, moonkoi) {
		t.Fatal("unlisted cross-species pair was accepted")
	}
	if _, err := Breed(carp, bass, []byte("incompatible")); err == nil {
		t.Fatal("unlisted cross-species breeding should be rejected")
	}
}

func TestThirdGenerationCap(t *testing.T) {
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
	third.ID = "e"
	if _, err = Breed(third, a, []byte("generation-four")); err == nil {
		t.Fatal("fourth generation should be rejected")
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
