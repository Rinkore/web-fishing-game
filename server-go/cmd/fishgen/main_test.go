package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func decodeNRGBA(t *testing.T, path string) *image.NRGBA {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	bounds := decoded.Bounds()
	out := image.NewNRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	for y := 0; y < bounds.Dy(); y++ {
		for x := 0; x < bounds.Dx(); x++ {
			out.SetNRGBA(x, y, color.NRGBAModel.Convert(decoded.At(bounds.Min.X+x, bounds.Min.Y+y)).(color.NRGBA))
		}
	}
	return out
}

func TestCommittedLayersRebuildEveryReferencePixel(t *testing.T) {
	root := filepath.Clean(filepath.Join("..", "..", ".."))
	genetics := filepath.Join(root, "frontend", "assets", "genetics")
	rawCatalog, err := os.ReadFile(filepath.Join(genetics, "catalog.json"))
	if err != nil {
		t.Fatal(err)
	}
	var c catalog
	if err = json.Unmarshal(rawCatalog, &c); err != nil {
		t.Fatal(err)
	}
	if len(c.Species) != len(profiles) {
		t.Fatalf("catalog contains %d species, want %d", len(c.Species), len(profiles))
	}
	for id := range profiles {
		sourcePath := filepath.Join(root, "frontend", "assets", "fish", id+".png")
		raw, readErr := os.ReadFile(sourcePath)
		if readErr != nil {
			t.Fatal(readErr)
		}
		digest := sha256.Sum256(raw)
		if got, want := hex.EncodeToString(digest[:]), c.Species[id].SHA256; got != want {
			t.Fatalf("%s reference digest %s, catalog says %s", id, got, want)
		}
		source := decodeNRGBA(t, sourcePath)
		rebuilt := image.NewNRGBA(source.Bounds())
		for _, locus := range loci[1:] {
			layer := decodeNRGBA(t, filepath.Join(genetics, id+"-"+locus+".png"))
			if layer.Bounds() != source.Bounds() {
				t.Fatalf("%s %s layer bounds do not match reference", id, locus)
			}
			for y := 0; y < layer.Bounds().Dy(); y++ {
				for x := 0; x < layer.Bounds().Dx(); x++ {
					if pixel := layer.NRGBAAt(x, y); pixel.A != 0 {
						rebuilt.SetNRGBA(x, y, pixel)
					}
				}
			}
		}
		if !visibleEqual(source, rebuilt) {
			t.Fatalf("%s committed layers do not reconstruct the reference", id)
		}
		if !c.Species[id].ReferenceExact {
			t.Fatalf("%s lacks the exact-reference marker", id)
		}
	}
}

func TestWhiteBodiesSurviveBackgroundExtraction(t *testing.T) {
	root := filepath.Clean(filepath.Join("..", "..", ".."))
	for _, sample := range []struct {
		id   string
		x, y int
	}{
		{"white", 100, 26}, {"silvercarp", 140, 121}, {"sardine", 130, 70},
	} {
		fish := decodeNRGBA(t, filepath.Join(root, "frontend", "assets", "fish", sample.id+".png"))
		p := fish.NRGBAAt(sample.x, sample.y)
		if p.A != 255 || p.R < 180 || p.G < 180 || p.B < 180 {
			t.Fatalf("%s white body pixel missing at %d,%d: %#v", sample.id, sample.x, sample.y, p)
		}
	}
}

func TestStandingFloatKeepsWhiteBody(t *testing.T) {
	root := filepath.Clean(filepath.Join("..", "..", ".."))
	stand := decodeNRGBA(t, filepath.Join(root, "frontend", "assets", "ui", "char", "chibi-stand-base.png"))
	p := stand.NRGBAAt(194, 82)
	if p.A != 255 || p.R < 230 || p.G < 230 || p.B < 220 {
		t.Fatalf("standing float white section missing: %#v", p)
	}
}

func TestBoatPoseRemovesStoolWithoutChangingReferencePose(t *testing.T) {
	root := filepath.Clean(filepath.Join("..", "..", ".."))
	dir := filepath.Join(root, "frontend", "assets", "ui", "char")
	seated := decodeNRGBA(t, filepath.Join(dir, "chibi-sit-base.png"))
	boat := decodeNRGBA(t, filepath.Join(dir, "chibi_boat_orange_green_light.png"))
	if seated.NRGBAAt(35, 214).A == 0 || boat.NRGBAAt(35, 214).A != 0 {
		t.Fatal("boat-only layer did not remove the separate stool")
	}
	if seated.NRGBAAt(90, 120) != boat.NRGBAAt(90, 120) {
		t.Fatal("boat version changed the reference face or upper body")
	}
}

func TestTwinTailCharacterAssetsAreComplete(t *testing.T) {
	root := filepath.Clean(filepath.Join("..", "..", ".."))
	portraitDir := filepath.Join(root, "frontend", "assets", "ui", "char")
	for _, name := range []string{"twin-base.png", "twin-stand.png", "twin-fish-stand.png", "twin-sit.png", "twin-boat.png"} {
		img := decodeNRGBA(t, filepath.Join(portraitDir, name))
		if img.Bounds().Dx() < 150 || img.Bounds().Dy() < 200 {
			t.Fatalf("%s is unexpectedly small", name)
		}
	}
	sit := decodeNRGBA(t, filepath.Join(portraitDir, "twin-sit.png"))
	boat := decodeNRGBA(t, filepath.Join(portraitDir, "twin-boat.png"))
	if sit.NRGBAAt(80, 260).A == 0 || boat.NRGBAAt(80, 260).A != 0 {
		t.Fatal("twin boat pose did not remove the folding chair")
	}
	if sit.NRGBAAt(150, 100) != boat.NRGBAAt(150, 100) {
		t.Fatal("twin boat pose changed the reference face")
	}
	castDir := filepath.Join(root, "frontend", "assets", "ui", "chars")
	for _, name := range []string{"twin-cast-1.png", "twin-cast-2.png", "twin-cast-3.png", "twin-cast-4.png", "twin-cast-5.png", "twin-cast-idle.png"} {
		img := decodeNRGBA(t, filepath.Join(castDir, name))
		if img.Bounds().Dx() != 1000 || img.Bounds().Dy() != 400 {
			t.Fatalf("%s has incorrect map frame size", name)
		}
		visible := 0
		for y := 0; y < 400; y++ {
			for x := 0; x < 1000; x++ {
				if img.NRGBAAt(x, y).A > 0 {
					visible++
				}
			}
		}
		if visible < 1000 {
			t.Fatalf("%s lost its sprite", name)
		}
	}
}

func TestWhitePonytailCharacterAssetsAreComplete(t *testing.T) {
	root := filepath.Clean(filepath.Join("..", "..", ".."))
	portraitDir := filepath.Join(root, "frontend", "assets", "ui", "char")
	for _, name := range []string{"pony-base.png", "pony-stand.png", "pony-fish-stand.png", "pony-sit.png", "pony-boat.png"} {
		img := decodeNRGBA(t, filepath.Join(portraitDir, name))
		if img.Bounds().Dx() < 150 || img.Bounds().Dy() < 200 {
			t.Fatalf("%s is unexpectedly small", name)
		}
	}
	base := decodeNRGBA(t, filepath.Join(portraitDir, "pony-base.png"))
	hair := base.NRGBAAt(100, 20)
	if hair.A == 0 || hair.R < 200 || hair.G < 200 || hair.B < 200 {
		t.Fatalf("white hair was removed with the paper: %#v", hair)
	}
	sit := decodeNRGBA(t, filepath.Join(portraitDir, "pony-sit.png"))
	boat := decodeNRGBA(t, filepath.Join(portraitDir, "pony-boat.png"))
	removed := 0
	for y := sit.Bounds().Dy() * 74 / 100; y < sit.Bounds().Dy(); y++ {
		for x := 0; x < sit.Bounds().Dx()*58/100; x++ {
			if sit.NRGBAAt(x, y).A > 0 && boat.NRGBAAt(x, y).A == 0 {
				removed++
			}
		}
	}
	if removed < 20 {
		t.Fatal("white pony boat pose did not remove the separate stool")
	}
	if sit.NRGBAAt(100, 100) != boat.NRGBAAt(100, 100) {
		t.Fatal("white pony boat pose changed the reference face")
	}
	castDir := filepath.Join(root, "frontend", "assets", "ui", "chars")
	for _, name := range []string{"pony-cast-1.png", "pony-cast-2.png", "pony-cast-3.png", "pony-cast-4.png", "pony-cast-5.png", "pony-cast-idle.png"} {
		img := decodeNRGBA(t, filepath.Join(castDir, name))
		if img.Bounds().Dx() != 1000 || img.Bounds().Dy() != 400 {
			t.Fatalf("%s has incorrect map frame size", name)
		}
		visible := 0
		for y := 0; y < 400; y++ {
			for x := 0; x < 1000; x++ {
				if img.NRGBAAt(x, y).A > 0 {
					visible++
				}
			}
		}
		if visible < 1000 {
			t.Fatalf("%s lost its sprite", name)
		}
	}
}
