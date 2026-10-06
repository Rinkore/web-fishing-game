// Package breeding owns the fish house's reference-derived diploid genetics.
package breeding

import (
	"crypto/sha256"
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"errors"
	"math"
	"math/rand/v2"
)

//go:embed catalog.json
var catalogJSON []byte

const (
	// MutationRate applies independently to each wild mutation allele copied
	// into an offspring. Existing mutation alleles follow ordinary inheritance.
	MutationRate = 0.01
	BreedCost    = 100
	Capacity     = 60
	sizeLocus    = "size"
)

var mutationLoci = []string{"albino", "star", "veil", "glow"}
var colorLoci = []string{"crimson", "golden", "azure", "melanic", "opal"}
var ornamentLoci = []string{"goldscale", "moonlight"}

// Earlier founders retain the digest of the damaged cutout in their immutable
// genome. Accept those exact historical digests after restoring white pixels.
var legacyReferenceSHA = map[string]string{
	"white":      "177b352ad9fb90159382188deef7e32a11ea18e5602fae57b7bd9afb5ce9f52c",
	"silvercarp": "0d34966173bc5f03a7536e3c3cbdc12b658a94fffd0fcaaeb580a0b1a4d9c8a6",
	"sardine":    "aeb2d66b61e4520f6cbe22018d0f9cb0e29914f364b767ad866da5df04c69eaf",
}

type Species struct {
	ID             string         `json:"id"`
	Name           string         `json:"name"`
	Family         string         `json:"family"`
	Group          string         `json:"group"`
	BreedGroup     string         `json:"breedGroup"`
	BreedNote      string         `json:"breedNote"`
	Notes          string         `json:"notes"`
	Rank           map[string]int `json:"rank"`
	TailEnabled    bool           `json:"tailEnabled"`
	SHA256         string         `json:"sha256"`
	ReferenceExact bool           `json:"referenceExact"`
	Habitat        string         `json:"habitat"`
	Ornamental     bool           `json:"ornamental"`
}

type Mutation struct {
	Label       string `json:"label"`
	Allele      string `json:"allele"`
	Wild        string `json:"wild"`
	Dominance   string `json:"dominance"`
	Description string `json:"description"`
	Reference   string `json:"reference,omitempty"`
}

type Definitions struct {
	Version   int                 `json:"version"`
	Loci      []string            `json:"loci"`
	Labels    map[string]string   `json:"labels"`
	Mutations map[string]Mutation `json:"mutations"`
	Colors    map[string]Mutation `json:"colors"`
	Ornaments map[string]Mutation `json:"ornaments"`
	Pairs     [][2]string         `json:"pairs"`
	Species   map[string]Species  `json:"species"`
}

var Catalog = func() Definitions {
	var c Definitions
	if err := json.Unmarshal(catalogJSON, &c); err != nil {
		panic(err)
	}
	return c
}()

type Genome map[string][2]string

type Fish struct {
	ID              string    `json:"id"`
	Species         string    `json:"species"`
	Generation      int       `json:"generation"`
	Parents         [2]string `json:"parents"`
	Genes           Genome    `json:"genes"`
	Mutations       []string  `json:"mutations"`
	Active          bool      `json:"active"`
	BornAt          int64     `json:"bornAt"`
	ReferenceSHA256 string    `json:"referenceSha256"`
}

type Expression struct {
	Alleles   [2]string `json:"alleles"`
	Winner    string    `json:"winner"`
	Source    string    `json:"source"`
	Dominant  string    `json:"dominant"`
	Recessive string    `json:"recessive,omitempty"`
	Mode      string    `json:"mode"`
	Zygosity  string    `json:"zygosity"`
	Carrier   bool      `json:"carrier"`
	Hidden    bool      `json:"hidden"`
	Reason    string    `json:"reason,omitempty"`
}

type Phenotype struct {
	Body            string                `json:"body"`
	Size            string                `json:"size"`
	Traits          map[string]Expression `json:"traits"`
	Mutations       map[string]bool       `json:"mutations"`
	Colors          map[string]bool       `json:"colors"`
	Ornaments       map[string]bool       `json:"ornaments"`
	ReferenceExact  bool                  `json:"referenceExact"`
	ReferenceSHA256 string                `json:"referenceSha256"`
}

func validTier(tier string) bool {
	return tier == "normal" || tier == "large" || tier == "giant"
}

// Founder converts one inventory fish into a homozygous generation-zero
// parent. Every structural locus points at the same source sprite and every
// mutation locus is wild type, so its gene-derived phenotype is the exact
// reference PNG whose digest is stored on the individual.
func Founder(species string, tiers ...string) (Fish, error) {
	s, ok := Catalog.Species[species]
	if !ok || s.Group != "fish" {
		return Fish{}, errors.New("不支持该亲代")
	}
	tier := "normal"
	if len(tiers) > 0 {
		tier = tiers[0]
	}
	if !validTier(tier) {
		return Fish{}, errors.New("无效体型档位")
	}
	f := Fish{Species: species, ReferenceSHA256: s.SHA256, Genes: Genome{}, Active: true, Mutations: []string{}}
	for _, locus := range Catalog.Loci {
		f.Genes[locus] = [2]string{species, species}
	}
	f.Genes[sizeLocus] = [2]string{tier, tier}
	for _, locus := range mutationLoci {
		m := Catalog.Mutations[locus]
		f.Genes[locus] = [2]string{m.Wild, m.Wild}
	}
	for _, locus := range colorLoci {
		m := Catalog.Colors[locus]
		f.Genes[locus] = [2]string{m.Wild, m.Wild}
	}
	for _, locus := range ornamentLoci {
		f.Genes[locus] = inheritedOrnament(f, locus)
	}
	return f, nil
}

func sameBreedingLine(a, b Species) bool {
	if a.ID == b.ID {
		return true
	}
	return a.Group == b.Group && a.BreedGroup != "" && a.BreedGroup == b.BreedGroup
}

// CanPair is intentionally stricter than anatomical compatibility. Different
// ids may pair only when the catalog places them in the small, documented
// real-world hybrid group generated by cmd/fishgen.
func CanPair(a, b Fish) bool {
	sa, oka := Catalog.Species[a.Species]
	sb, okb := Catalog.Species[b.Species]
	if !oka || !okb {
		return false
	}
	if sa.ID == sb.ID {
		return true
	}
	for _, pair := range Catalog.Pairs {
		if pair == [2]string{sa.ID, sb.ID} || pair == [2]string{sb.ID, sa.ID} {
			return true
		}
	}
	return false
}

func Valid(f Fish) bool {
	if f.Generation < 0 || len(f.Genes) < len(Catalog.Loci)+len(mutationLoci)+1 || len(f.Genes) > len(Catalog.Loci)+len(mutationLoci)+len(colorLoci)+len(ornamentLoci)+1 {
		return false
	}
	for locus := range f.Genes {
		known := locus == sizeLocus
		for _, candidate := range append(append(append(append([]string{}, Catalog.Loci...), mutationLoci...), colorLoci...), ornamentLoci...) {
			if locus == candidate {
				known = true
				break
			}
		}
		if !known {
			return false
		}
	}
	species, ok := Catalog.Species[f.Species]
	referenceValid := f.ReferenceSHA256 == species.SHA256
	if legacy, known := legacyReferenceSHA[f.Species]; known && f.ReferenceSHA256 == legacy {
		referenceValid = true
	}
	if !ok || species.Group != "fish" || !referenceValid || !species.ReferenceExact {
		return false
	}
	for _, locus := range Catalog.Loci {
		pair, exists := f.Genes[locus]
		if !exists {
			return false
		}
		for _, allele := range pair {
			donor, exists := Catalog.Species[allele]
			if !exists || !sameBreedingLine(species, donor) {
				return false
			}
		}
	}
	sizes, exists := f.Genes[sizeLocus]
	if !exists || !validTier(sizes[0]) || !validTier(sizes[1]) {
		return false
	}
	for _, locus := range mutationLoci {
		pair, exists := f.Genes[locus]
		if !exists {
			return false
		}
		m := Catalog.Mutations[locus]
		for _, allele := range pair {
			if allele != m.Wild && allele != m.Allele {
				return false
			}
		}
	}
	// Archived genomes created before colour loci existed remain valid; absent
	// loci are interpreted as homozygous wild type and normalized when read.
	for _, locus := range colorLoci {
		pair, exists := f.Genes[locus]
		if !exists {
			continue
		}
		m := Catalog.Colors[locus]
		for _, allele := range pair {
			if allele != m.Wild && allele != m.Allele {
				return false
			}
		}
	}
	for _, locus := range ornamentLoci {
		pair, exists := f.Genes[locus]
		if !exists {
			continue
		}
		m := Catalog.Ornaments[locus]
		for _, allele := range pair {
			if allele != m.Wild && allele != m.Allele {
				return false
			}
		}
	}
	return true
}

func inheritedOrnament(f Fish, locus string) [2]string {
	if pair, exists := f.Genes[locus]; exists {
		return pair
	}
	m := Catalog.Ornaments[locus]
	pair := [2]string{m.Wild, m.Wild}
	for i, donor := range f.Genes["skin"] {
		if donor == m.Reference {
			pair[i] = m.Allele
		}
	}
	return pair
}

func normalizeLegacy(f Fish) Fish {
	for _, locus := range colorLoci {
		if _, exists := f.Genes[locus]; !exists {
			m := Catalog.Colors[locus]
			f.Genes[locus] = [2]string{m.Wild, m.Wild}
		}
	}
	for _, locus := range ornamentLoci {
		f.Genes[locus] = inheritedOrnament(f, locus)
	}
	return f
}

func structuralWinner(locus string, pair [2]string) string {
	a, b := Catalog.Species[pair[0]].Rank[locus], Catalog.Species[pair[1]].Rank[locus]
	if a > b || a == b && pair[0] < pair[1] {
		return pair[0]
	}
	return pair[1]
}

func sizeWinner(pair [2]string) string {
	rank := map[string]int{"normal": 1, "large": 2, "giant": 3}
	if rank[pair[0]] >= rank[pair[1]] {
		return pair[0]
	}
	return pair[1]
}

func expression(pair [2]string, winner, mode string) Expression {
	e := Expression{Alleles: pair, Winner: winner, Source: winner, Dominant: winner, Mode: mode, Zygosity: "homozygous"}
	if pair[0] != pair[1] {
		e.Zygosity = "heterozygous"
		e.Carrier = true
		if pair[0] == winner {
			e.Recessive = pair[1]
		} else {
			e.Recessive = pair[0]
		}
	}
	return e
}

func anatomyCompatible(body, donor Species, locus string) bool {
	if locus == "skin" {
		return body.Group == donor.Group
	}
	if body.Family == donor.Family {
		return true
	}
	// Similar fin architectures can express one another. Eels, rays, flatfish,
	// round fish and cephalopods keep incompatible parts latent in the genome.
	ordinary := func(family string) bool {
		return family == "streamlined" || family == "elongate" || family == "deep" || family == "shark"
	}
	return locus != "head" && ordinary(body.Family) && ordinary(donor.Family)
}

func Express(f Fish) (Phenotype, error) {
	if !Valid(f) {
		return Phenotype{}, errors.New("无效基因")
	}
	body := structuralWinner("body", f.Genes["body"])
	p := Phenotype{
		Body:            body,
		Traits:          map[string]Expression{},
		Mutations:       map[string]bool{},
		Colors:          map[string]bool{},
		Ornaments:       map[string]bool{},
		ReferenceExact:  true,
		ReferenceSHA256: Catalog.Species[body].SHA256,
	}
	for _, locus := range Catalog.Loci {
		winner := structuralWinner(locus, f.Genes[locus])
		e := expression(f.Genes[locus], winner, "complete_dominance")
		if locus != "body" && !anatomyCompatible(Catalog.Species[body], Catalog.Species[winner], locus) {
			e.Hidden = true
			e.Source = body
			e.Reason = "体型骨架不兼容：基因保留，外观使用体型原生结构"
		}
		if e.Source != body {
			p.ReferenceExact = false
		}
		p.Traits[locus] = e
	}
	p.Size = sizeWinner(f.Genes[sizeLocus])
	p.Traits[sizeLocus] = expression(f.Genes[sizeLocus], p.Size, "complete_dominance")
	for _, locus := range mutationLoci {
		m := Catalog.Mutations[locus]
		pair := f.Genes[locus]
		count := 0
		for _, allele := range pair {
			if allele == m.Allele {
				count++
			}
		}
		on := count == 2 || count == 1 && m.Dominance == "dominant"
		winner := m.Wild
		if on {
			winner = m.Allele
		}
		e := expression(pair, winner, m.Dominance)
		if count == 1 && m.Dominance == "recessive" {
			e.Hidden = true
			e.Reason = "杂合携带：隐性等位基因尚未成对"
		}
		if locus == "veil" && on && !Catalog.Species[body].TailEnabled {
			e.Hidden = true
			e.Source = m.Wild
			e.Reason = "此体型没有独立尾鳍，流纱尾基因潜伏"
			on = false
		}
		if on {
			p.ReferenceExact = false
		}
		p.Traits[locus] = e
		p.Mutations[locus] = on
	}
	for _, locus := range colorLoci {
		m := Catalog.Colors[locus]
		pair, exists := f.Genes[locus]
		if !exists {
			pair = [2]string{m.Wild, m.Wild}
		}
		count := 0
		for _, allele := range pair {
			if allele == m.Allele {
				count++
			}
		}
		on := count == 2 || count == 1 && m.Dominance == "dominant"
		winner := m.Wild
		if on {
			winner = m.Allele
			p.ReferenceExact = false
		}
		e := expression(pair, winner, m.Dominance)
		if count == 1 && !on {
			e.Hidden = true
			e.Reason = "杂合携带：异色基因潜伏，需两份等位基因才表达"
		}
		p.Traits[locus] = e
		p.Colors[locus] = on
	}
	for _, locus := range ornamentLoci {
		m := Catalog.Ornaments[locus]
		pair := inheritedOrnament(f, locus)
		count := 0
		for _, allele := range pair {
			if allele == m.Allele {
				count++
			}
		}
		on := count == 2 || count == 1 && m.Dominance == "dominant"
		winner := m.Wild
		if on {
			winner = m.Allele
		}
		e := expression(pair, winner, m.Dominance)
		if count == 1 && !on {
			e.Hidden = true
			e.Reason = "杂合携带：月光性状尚未成对"
		}
		if on {
			e.Source = m.Reference
			if p.Traits["skin"].Source != m.Reference {
				p.ReferenceExact = false
			}
		} else if p.Traits["skin"].Source == m.Reference {
			// A native-looking skin must not bypass a segregated ornament locus.
			// The renderer removes its special colour before applying other genes.
			p.ReferenceExact = false
		}
		p.Traits[locus] = e
		p.Ornaments[locus] = on
	}
	return p, nil
}

func Breed(a, b Fish, seed []byte, directed ...string) (Fish, error) {
	if !Valid(a) || !Valid(b) {
		return Fish{}, errors.New("亲代基因无效")
	}
	if a.ID == "" || a.ID == b.ID || !a.Active || !b.Active {
		return Fish{}, errors.New("请选择两条不同的在养亲本")
	}
	if max(a.Generation, b.Generation) == math.MaxInt {
		return Fish{}, errors.New("繁育代数超出可表示范围")
	}
	generation := max(a.Generation, b.Generation) + 1
	target := ""
	if len(directed) > 1 {
		return Fish{}, errors.New("每次只能定向一个基因")
	}
	if len(directed) == 1 && directed[0] != "" {
		target = directed[0]
		if _, mutation := Catalog.Mutations[target]; !mutation {
			if _, color := Catalog.Colors[target]; !color {
				return Fish{}, errors.New("无效定向基因")
			}
		}
	}
	if !CanPair(a, b) {
		return Fish{}, errors.New("仅同种鱼或现实中有杂交记录的鱼可以配对")
	}
	hash := sha256.Sum256(seed)
	rng := rand.New(rand.NewPCG(binary.LittleEndian.Uint64(hash[:8]), binary.LittleEndian.Uint64(hash[8:16])))
	f := Fish{Generation: generation, Parents: [2]string{a.ID, b.ID}, Active: true, Genes: Genome{}, Mutations: []string{}}
	loci := append(append(append(append(append([]string{}, Catalog.Loci...), sizeLocus), mutationLoci...), colorLoci...), ornamentLoci...)
	mutated := map[string]bool{}
	for _, locus := range loci {
		parentA, parentB := a.Genes[locus], b.Genes[locus]
		if _, ornament := Catalog.Ornaments[locus]; ornament {
			parentA = inheritedOrnament(a, locus)
			parentB = inheritedOrnament(b, locus)
		}
		mutation, special := Catalog.Mutations[locus]
		if color, ok := Catalog.Colors[locus]; ok {
			mutation, special = color, true
		}
		if _, exists := a.Genes[locus]; !exists && special {
			parentA = [2]string{mutation.Wild, mutation.Wild}
		}
		if _, exists := b.Genes[locus]; !exists && special {
			parentB = [2]string{mutation.Wild, mutation.Wild}
		}
		pair := [2]string{parentA[rng.IntN(2)], parentB[rng.IntN(2)]}
		if special {
			for i := range pair {
				if pair[i] == mutation.Wild && rng.Float64() < MutationRate {
					pair[i] = mutation.Allele
					mutated[locus] = true
				}
			}
			if locus == target {
				if pair[0] == mutation.Wild {
					pair[0] = mutation.Allele
					mutated[locus] = true
				} else if pair[1] == mutation.Wild {
					pair[1] = mutation.Allele
					mutated[locus] = true
				}
			}
		}
		f.Genes[locus] = pair
	}
	for _, locus := range append(append([]string{}, mutationLoci...), colorLoci...) {
		if mutated[locus] {
			f.Mutations = append(f.Mutations, locus)
		}
	}
	f.Species = structuralWinner("body", f.Genes["body"])
	f.ReferenceSHA256 = Catalog.Species[f.Species].SHA256
	return f, nil
}
