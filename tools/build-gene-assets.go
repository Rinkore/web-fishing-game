// Build deterministic pixel-art breeding reagents and repeatable colour tiles.
// go run tools/build-gene-assets.go -root .
package main

import (
	"flag"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
)

type rgb struct{ r, g, b uint8 }

var reagents = map[string]rgb{
	"gene_albino": {232, 223, 214},
	"gene_star":   {239, 193, 77},
	"gene_veil":   {186, 142, 218},
	"gene_glow":   {92, 223, 220},
	"gene_prism":  {184, 118, 221},
}
var patterns = map[string]rgb{
	"crimson": {240, 93, 119},
	"golden":  {255, 218, 104},
	"azure":   {91, 207, 244},
	"melanic": {30, 32, 51},
	"opal":    {197, 143, 249},
}

func main() {
	root := flag.String("root", ".", "repository root")
	flag.Parse()
	for name, pigment := range reagents {
		path := filepath.Join(*root, "frontend", "assets", "item", name+".png")
		if err := save(path, vial(name, pigment)); err != nil {
			panic(err)
		}
	}
	for name, pigment := range patterns {
		path := filepath.Join(*root, "frontend", "assets", "genetics", "pattern-"+name+".png")
		if err := save(path, tile(name, pigment)); err != nil {
			panic(err)
		}
	}
}

func rgba(c rgb, alpha uint8) color.NRGBA { return color.NRGBA{c.r, c.g, c.b, alpha} }
func block(img *image.NRGBA, x, y, w, h int, c color.NRGBA) {
	for py := y; py < y+h; py++ {
		for px := x; px < x+w; px++ {
			img.SetNRGBA(px, py, c)
		}
	}
}
func vial(name string, pigment rgb) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, 32, 32))
	ink := rgba(rgb{25, 37, 55}, 255)
	glass := rgba(rgb{136, 194, 211}, 255)
	block(img, 11, 2, 10, 3, ink)
	block(img, 12, 3, 8, 2, rgba(rgb{179, 143, 86}, 255))
	block(img, 12, 5, 8, 4, glass)
	block(img, 9, 8, 14, 2, ink)
	block(img, 7, 10, 18, 17, ink)
	block(img, 9, 27, 14, 2, ink)
	block(img, 9, 11, 14, 15, rgba(rgb{69, 105, 126}, 185))
	block(img, 10, 17, 12, 9, rgba(pigment, 255))
	block(img, 10, 12, 2, 11, rgba(rgb{207, 239, 245}, 210))
	block(img, 20, 13, 2, 5, rgba(rgb{83, 125, 151}, 220))
	block(img, 12, 27, 8, 1, rgba(rgb{204, 241, 245}, 255))
	accent := rgba(rgb{255, 249, 211}, 255)
	switch name {
	case "gene_albino":
		block(img, 14, 20, 4, 2, rgba(rgb{190, 62, 84}, 255))
	case "gene_star":
		block(img, 15, 18, 2, 7, accent)
		block(img, 12, 20, 8, 2, accent)
	case "gene_veil":
		block(img, 13, 19, 2, 5, accent)
		block(img, 17, 19, 2, 5, accent)
		block(img, 15, 21, 2, 5, accent)
	case "gene_glow":
		block(img, 14, 19, 4, 4, accent)
		block(img, 15, 18, 2, 6, accent)
	case "gene_prism":
		block(img, 12, 21, 2, 3, rgba(rgb{238, 96, 118}, 255))
		block(img, 15, 19, 2, 5, rgba(rgb{255, 220, 116}, 255))
		block(img, 18, 21, 2, 3, rgba(rgb{96, 212, 241}, 255))
	}
	return img
}

func tile(name string, pigment rgb) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, 16, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			paint := false
			switch name {
			case "crimson":
				paint = (x+2*y)%13 == 0
			case "golden":
				paint = (x*3+y*5)%17 == 1
			case "azure":
				paint = (x+y/2)%11 == 0
			case "melanic":
				paint = (x/3+y/3)%5 == 0 && x%3 == 0
			case "opal":
				paint = (x+y)%9 == 0
			}
			if !paint {
				continue
			}
			c := pigment
			if name == "opal" {
				palette := []rgb{{238, 132, 176}, {126, 223, 231}, {255, 216, 128}, {197, 143, 249}}
				c = palette[(x/4+y/4)%len(palette)]
			}
			img.SetNRGBA(x, y, rgba(c, 160))
		}
	}
	return img
}

func save(path string, img image.Image) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(f, img)
}
