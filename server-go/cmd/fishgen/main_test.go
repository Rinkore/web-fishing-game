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
