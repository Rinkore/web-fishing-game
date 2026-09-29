// Inspect and repair white fish pixels lost by the original white-background cutout.
// go run tools/repair-fish-whites.go -root .          # checkerboard previews only
// go run tools/repair-fish-whites.go -root . -write   # replace the three sources
package main

import (
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"os"
	"path/filepath"
)

func main() {
	root := flag.String("root", ".", "repository root")
	write := flag.Bool("write", false, "replace source fish PNGs after preview verification")
	flag.Parse()
	for _, id := range []string{"white", "silvercarp", "sardine"} {
		path := filepath.Join(*root, "frontend", "assets", "fish", id+".png")
		original, err := read(path)
		if err != nil {
			panic(err)
		}
		var restored *image.NRGBA
		switch id {
		case "white":
			restored = repairWhite(original)
		case "silvercarp":
			restored = repairSilver(original)
		case "sardine":
			restored = repairSardine(original)
		}
		if *write {
			if err := save(path, restored); err != nil {
				panic(err)
			}
		} else {
			previewPath := filepath.Join(*root, "output", "fish-alpha-"+id+".png")
			if err := os.MkdirAll(filepath.Dir(previewPath), 0o755); err != nil {
				panic(err)
			}
			if err := save(previewPath, preview(original, restored)); err != nil {
				panic(err)
			}
			fmt.Println(previewPath)
		}
	}
	if !*write {
		stand, err := read(filepath.Join(*root, "frontend", "assets", "ui", "char", "chibi-stand-base.png"))
		if err != nil {
			panic(err)
		}
		crop := image.NewNRGBA(image.Rect(0, 0, 45, 95))
		draw.Draw(crop, crop.Bounds(), stand, image.Pt(stand.Bounds().Dx()-45, 45), draw.Src)
		if err := save(filepath.Join(*root, "output", "stand-float-alpha.png"), preview(crop, crop)); err != nil {
			panic(err)
		}
	}
}

func read(path string) (*image.NRGBA, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	decoded, err := png.Decode(f)
	if err != nil {
		return nil, err
	}
	b := decoded.Bounds()
	out := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(out, out.Bounds(), decoded, b.Min, draw.Src)
	return out, nil
}
func save(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(f, img)
}
func copyImage(src *image.NRGBA) *image.NRGBA {
	out := image.NewNRGBA(src.Bounds())
	copy(out.Pix, src.Pix)
	return out
}

type point struct{ x, y int }

func inside(poly []point, x, y int) bool {
	on := false
	for i, j := 0, len(poly)-1; i < len(poly); j, i = i, i+1 {
		a, b := poly[i], poly[j]
		if (a.y > y) != (b.y > y) && float64(x) < float64(b.x-a.x)*float64(y-a.y)/float64(b.y-a.y)+float64(a.x) {
			on = !on
		}
	}
	return on
}

func underpaint(src *image.NRGBA, shape []point, shade func(x, y int) color.NRGBA) *image.NRGBA {
	out := copyImage(src)
	for y := 0; y < src.Bounds().Dy(); y++ {
		for x := 0; x < src.Bounds().Dx(); x++ {
			if src.NRGBAAt(x, y).A == 0 && inside(shape, x, y) {
				out.SetNRGBA(x, y, shade(x, y))
			}
		}
	}
	return out
}

func repairWhite(src *image.NRGBA) *image.NRGBA {
	shape := []point{{2, 16}, {10, 8}, {32, 3}, {100, 2}, {145, 7}, {170, 16}, {158, 23}, {121, 29}, {55, 34}, {18, 30}, {2, 24}}
	return underpaint(src, shape, func(_, y int) color.NRGBA {
		if y > 28 {
			return color.NRGBA{215, 224, 225, 255}
		}
		return color.NRGBA{238, 241, 235, 255}
	})
}
func repairSilver(src *image.NRGBA) *image.NRGBA {
	shape := []point{{5, 68}, {25, 47}, {68, 31}, {143, 28}, {190, 41}, {216, 60}, {230, 82}, {211, 101}, {178, 119}, {121, 135}, {70, 129}, {27, 110}, {5, 91}}
	return underpaint(src, shape, func(_, y int) color.NRGBA {
		if y > 117 {
			return color.NRGBA{210, 219, 216, 255}
		}
		return color.NRGBA{233, 237, 230, 255}
	})
}
func repairSardine(src *image.NRGBA) *image.NRGBA {
	shape := []point{{10, 42}, {31, 23}, {83, 22}, {148, 25}, {215, 39}, {235, 52}, {211, 67}, {167, 81}, {121, 87}, {68, 83}, {31, 74}, {10, 62}}
	return underpaint(src, shape, func(_, y int) color.NRGBA {
		if y > 74 {
			return color.NRGBA{190, 211, 222, 255}
		}
		return color.NRGBA{221, 235, 238, 255}
	})
}

func preview(a, b *image.NRGBA) *image.NRGBA {
	const scale = 4
	w, h := a.Bounds().Dx(), a.Bounds().Dy()
	out := image.NewNRGBA(image.Rect(0, 0, 2*w*scale, h*scale))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			bg := color.NRGBA{125, 52, 132, 255}
			if (x/8+y/8)%2 == 0 {
				bg = color.NRGBA{66, 65, 94, 255}
			}
			for column, src := range []*image.NRGBA{a, b} {
				p := src.NRGBAAt(x, y)
				alpha := float64(p.A) / 255
				c := color.NRGBA{uint8(float64(p.R)*alpha + float64(bg.R)*(1-alpha)), uint8(float64(p.G)*alpha + float64(bg.G)*(1-alpha)), uint8(float64(p.B)*alpha + float64(bg.B)*(1-alpha)), 255}
				for dy := 0; dy < scale; dy++ {
					for dx := 0; dx < scale; dx++ {
						out.SetNRGBA((column*w+x)*scale+dx, y*scale+dy, c)
					}
				}
			}
		}
	}
	return out
}
