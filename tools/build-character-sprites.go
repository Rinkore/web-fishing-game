// Build the lilac-haired character variants from the player's reference art.
// The reference image is only needed for the first extraction; later runs use
// the committed transparent chibi-base.png. No Python or image API is needed.
//
// go run tools/build-character-sprites.go -source C:/path/to/reference.png -stand C:/path/to/standing.png -sit C:/path/to/sitting.png
// go run tools/build-character-sprites.go
package main

import (
	"errors"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
)

type shade struct{ r, g, b uint8 }

var hairs = map[string]shade{
	"orange": {190, 205, 244}, // reference lavender; keep its pixels unchanged
	"teal":   {129, 208, 219},
	"red":    {221, 148, 181},
	"cream":  {226, 225, 209},
}
var outfits = map[string]struct{ shirt, skirt, tie shade }{
	"green":  {shade{29, 30, 37}, shade{69, 68, 129}, shade{200, 56, 74}}, // reference sailor uniform
	"yellow": {shade{92, 71, 48}, shade{127, 91, 59}, shade{225, 181, 86}},
	"red":    {shade{93, 43, 61}, shade{125, 56, 91}, shade{238, 175, 190}},
	"blue":   {shade{40, 69, 99}, shade{50, 100, 141}, shade{105, 205, 214}},
}
var skinTone = map[string]float64{"light": 1, "tan": .82, "dark": .58}
var hairOrder = []string{"orange", "teal", "red", "cream"}
var outfitOrder = []string{"green", "yellow", "red", "blue"}
var skinOrder = []string{"light", "tan", "dark"}

func main() {
	source := flag.String("source", "", "optional original 1024px reference image")
	stand := flag.String("stand", "", "optional standing-with-rod reference image")
	sit := flag.String("sit", "", "optional seated-fishing reference image")
	root := flag.String("root", ".", "repository root")
	flag.Parse()
	if err := run(*root, *source, *stand, *sit); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(root, source, stand, sit string) error {
	portraitDir := filepath.Join(root, "frontend", "assets", "ui", "char")
	miniDir := filepath.Join(root, "frontend", "assets", "ui", "chars")
	if err := os.MkdirAll(portraitDir, 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(miniDir, 0o755); err != nil {
		return err
	}
	basePath := filepath.Join(portraitDir, "chibi-base.png")
	var base *image.NRGBA
	if source != "" {
		img, err := readPNG(source)
		if err != nil {
			return err
		}
		base, err = extract(img)
		if err != nil {
			return err
		}
		if err := writePNG(basePath, base); err != nil {
			return err
		}
	} else {
		var err error
		base, err = readPNG(basePath)
		if err != nil {
			return err
		}
	}
	poses := map[string]*image.NRGBA{}
	for _, spec := range []struct {
		name, source string
		bounds       [4]int
	}{
		{"stand", stand, [4]int{37, 66, 34, 70}},
		{"sit", sit, [4]int{35, 74, 34, 72}},
	} {
		path := filepath.Join(portraitDir, "chibi-"+spec.name+"-base.png")
		var pose *image.NRGBA
		var err error
		if spec.source != "" {
			var original *image.NRGBA
			original, err = readPNG(spec.source)
			if err != nil {
				return err
			}
			pose, err = extractWindow(original, spec.bounds)
			if err != nil {
				return err
			}
			if err = writePNG(path, pose); err != nil {
				return err
			}
		} else {
			pose, err = readPNG(path)
			if err != nil {
				return err
			}
		}
		pose = restoreFloatWhite(pose, spec.name)
		if err = writePNG(path, pose); err != nil {
			return err
		}
		poses[spec.name] = pose
	}
	for _, hair := range hairOrder {
		for _, outfit := range outfitOrder {
			for _, skin := range skinOrder {
				variant := recolor(base, hair, outfit, skin, "portrait")
				stem := "chibi_" + hair + "_" + outfit + "_" + skin
				if err := writePNG(filepath.Join(portraitDir, stem+".png"), variant); err != nil {
					return err
				}
				for _, poseName := range []string{"stand", "sit"} {
					poseVariant := recolor(poses[poseName], hair, outfit, skin, poseName)
					path := filepath.Join(portraitDir, "chibi_"+poseName+"_"+hair+"_"+outfit+"_"+skin+".png")
					if err := writePNG(path, poseVariant); err != nil {
						return err
					}
					if poseName == "sit" {
						boatPath := filepath.Join(portraitDir, "chibi_boat_"+hair+"_"+outfit+"_"+skin+".png")
						if err := writePNG(boatPath, withoutStool(poseVariant)); err != nil {
							return err
						}
					}
				}
				for _, pose := range []string{"a", "b", "hold", "sit"} {
					if err := writePNG(filepath.Join(miniDir, stem+"_"+pose+".png"), mini(variant, pose)); err != nil {
						return err
					}
				}
			}
		}
	}
	fmt.Printf("character sprites: %dx%d portrait, 48 looks for each standing/seated pose\n", base.Bounds().Dx(), base.Bounds().Dy())
	return nil
}

// The reference's separate wooden stool belongs on land. In the boat the
// gunwale replaces it; retain the exact upper-body pose, rod, line and float.
func withoutStool(src *image.NRGBA) *image.NRGBA {
	out := image.NewNRGBA(src.Bounds())
	copy(out.Pix, src.Pix)
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	for y := h * 76 / 100; y < h; y++ {
		for x := 0; x < w*53/100; x++ {
			out.SetNRGBA(x, y, color.NRGBA{})
		}
	}
	return out
}

// Pale bobber pixels touched the white paper in the reference and were lost
// during background flood-fill. Rebuild only the narrow white body directly
// below its red cap; the existing line and dark hook remain untouched.
func restoreFloatWhite(src *image.NRGBA, pose string) *image.NRGBA {
	out := image.NewNRGBA(src.Bounds())
	copy(out.Pix, src.Pix)
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	xStart, yStart, yEnd := w*88/100, h*17/100, h*55/100
	if pose == "sit" {
		xStart, yStart, yEnd = w*80/100, h*70/100, h*98/100
	}
	left, right, top, bottom := w, -1, h, -1
	for y := yStart; y < yEnd; y++ {
		for x := xStart; x < w; x++ {
			p := src.NRGBAAt(x, y)
			if p.A > 180 && p.R > 165 && int(p.R) > int(p.G)*3/2 && int(p.R) > int(p.B)*3/2 {
				if x < left {
					left = x
				}
				if x > right {
					right = x
				}
				if y < top {
					top = y
				}
				if y > bottom {
					bottom = y
				}
			}
		}
	}
	if right < left || bottom-top > 20 {
		return out
	}
	center := (left + right) / 2
	for y := bottom + 1; y <= min(h-1, bottom+16); y++ {
		half := 2
		if y > bottom+11 {
			half = 1
		}
		for x := center - half; x <= center+half; x++ {
			if x >= 0 && x < w && src.NRGBAAt(x, y).A == 0 {
				out.SetNRGBA(x, y, color.NRGBA{241, 244, 238, 255})
			}
		}
	}
	return out
}

func readPNG(path string) (*image.NRGBA, error) {
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
	img := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	for y := 0; y < b.Dy(); y++ {
		for x := 0; x < b.Dx(); x++ {
			img.SetNRGBA(x, y, color.NRGBAModel.Convert(decoded.At(x+b.Min.X, y+b.Min.Y)).(color.NRGBA))
		}
	}
	return img, nil
}

func writePNG(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(f, img)
}

func paper(p color.NRGBA) bool {
	if p.A == 0 {
		return true
	}
	lo, hi := p.R, p.R
	for _, v := range []uint8{p.G, p.B} {
		if v < lo {
			lo = v
		}
		if v > hi {
			hi = v
		}
	}
	return p.R >= 222 && p.G >= 222 && p.B >= 219 && hi-lo <= 38
}

func extract(src *image.NRGBA) (*image.NRGBA, error) {
	return extractWindow(src, [4]int{39, 61, 36, 69})
}

func extractWindow(src *image.NRGBA, bounds [4]int) (*image.NRGBA, error) {
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	// The prompt image has one centred figure; this window excludes the corner
	// watermark and keeps white clothing enclosed by the figure's silhouette.
	x0, x1 := w*bounds[0]/100, w*bounds[1]/100
	y0, y1 := h*bounds[2]/100, h*bounds[3]/100
	cw, ch := x1-x0, y1-y0
	background := make([]bool, cw*ch)
	queue := make([]int, 0, cw*2+ch*2)
	add := func(x, y int) {
		if x < 0 || y < 0 || x >= cw || y >= ch {
			return
		}
		i := y*cw + x
		if background[i] || !paper(src.NRGBAAt(x0+x, y0+y)) {
			return
		}
		background[i] = true
		queue = append(queue, i)
	}
	for x := 0; x < cw; x++ {
		add(x, 0)
		add(x, ch-1)
	}
	for y := 0; y < ch; y++ {
		add(0, y)
		add(cw-1, y)
	}
	for head := 0; head < len(queue); head++ {
		i := queue[head]
		x, y := i%cw, i/cw
		add(x-1, y)
		add(x+1, y)
		add(x, y-1)
		add(x, y+1)
	}
	// Keep real detached details such as shoes; discard tiny paper-grain islands.
	seen := make([]bool, cw*ch)
	keep := make([]bool, cw*ch)
	for start := range seen {
		if seen[start] || background[start] {
			continue
		}
		component := []int{start}
		seen[start] = true
		for head := 0; head < len(component); head++ {
			i := component[head]
			x, y := i%cw, i/cw
			for _, next := range []int{i - 1, i + 1, i - cw, i + cw} {
				if next < 0 || next >= len(seen) || (next == i-1 && x == 0) || (next == i+1 && x == cw-1) || (next == i-cw && y == 0) || (next == i+cw && y == ch-1) {
					continue
				}
				if seen[next] || background[next] {
					continue
				}
				seen[next] = true
				component = append(component, next)
			}
		}
		if len(component) >= 18 {
			for _, i := range component {
				keep[i] = true
			}
		}
	}
	left, top, right, bottom := cw, ch, -1, -1
	for i, ok := range keep {
		if ok {
			x, y := i%cw, i/cw
			if x < left {
				left = x
			}
			if y < top {
				top = y
			}
			if x > right {
				right = x
			}
			if y > bottom {
				bottom = y
			}
		}
	}
	if right < left || bottom < top {
		return nil, errors.New("reference character not found")
	}
	left = max(0, left-3)
	top = max(0, top-3)
	right = min(cw-1, right+3)
	bottom = min(ch-1, bottom+3)
	out := image.NewNRGBA(image.Rect(0, 0, right-left+1, bottom-top+1))
	for y := top; y <= bottom; y++ {
		for x := left; x <= right; x++ {
			if keep[y*cw+x] {
				out.SetNRGBA(x-left, y-top, src.NRGBAAt(x0+x, y0+y))
			}
		}
	}
	return out, nil
}

func tint(p color.NRGBA, target, origin shade) color.NRGBA {
	base := float64(origin.r)*.3 + float64(origin.g)*.59 + float64(origin.b)*.11
	light := float64(p.R)*.3 + float64(p.G)*.59 + float64(p.B)*.11
	factor := light / max(1.0, base)
	clamp := func(v float64) uint8 { return uint8(min(255, max(0, int(v+.5)))) }
	return color.NRGBA{clamp(float64(target.r) * factor), clamp(float64(target.g) * factor), clamp(float64(target.b) * factor), p.A}
}

func recolor(base *image.NRGBA, hair, outfit, skin, pose string) *image.NRGBA {
	b := base.Bounds()
	w, h := b.Dx(), b.Dy()
	out := image.NewNRGBA(b)
	copy(out.Pix, base.Pix)
	uniform := outfits[outfit]
	outfitXMax, skinXMax := w, w
	if pose == "stand" {
		outfitXMax, skinXMax = w*3/4, w*4/5
	}
	if pose == "sit" {
		outfitXMax, skinXMax = w/2, w*2/3
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			p := base.NRGBAAt(x, y)
			if p.A == 0 {
				continue
			}
			fy := float64(y) / float64(h)
			r, g, bl := int(p.R), int(p.G), int(p.B)
			switch {
			case hair != "orange" && fy < .56 && bl > r+7 && bl > g+5 && r > 95:
				p = tint(p, hairs[hair], hairs["orange"])
			case outfit != "green" && x < outfitXMax && fy > .51 && fy < .78 && r > g*13/10 && r > bl*12/10 && r > 90:
				p = tint(p, uniform.tie, outfits["green"].tie)
			case outfit != "green" && x < outfitXMax && fy > .72 && fy < .9 && bl > r+8 && bl > g+3 && r < 145:
				p = tint(p, uniform.skirt, outfits["green"].skirt)
			case skin != "light" && x < skinXMax && fy > .18 && r >= 155 && g >= 110 && bl >= 75 && r > g+3 && g > bl+3 && r < g*13/10:
				factor := skinTone[skin]
				p.R = uint8(float64(p.R) * factor)
				p.G = uint8(float64(p.G) * (factor * .93))
				p.B = uint8(float64(p.B) * (factor * .89))
			case outfit != "green" && x < outfitXMax && fy > .52 && fy < .78 && r < 100 && g < 100 && bl < 110 && r+g+bl > 48:
				p = tint(p, uniform.shirt, outfits["green"].shirt)
			}
			out.SetNRGBA(x, y, p)
		}
	}
	return out
}

func mini(portrait *image.NRGBA, pose string) *image.NRGBA {
	const width, height = 64, 64
	out := image.NewNRGBA(image.Rect(0, 0, width, height))
	pw, ph := portrait.Bounds().Dx(), portrait.Bounds().Dy()
	for y := 0; y < 47; y++ {
		for x := 0; x < 30; x++ {
			sx, sy := x*pw/30, y*ph/47
			out.SetNRGBA(x+13, y+8, portrait.NRGBAAt(sx, sy))
		}
	}
	if pose == "sit" {
		return out
	}
	toX, toY := 57, 23
	if pose == "b" {
		toX, toY = 62, 16
	}
	if pose == "hold" {
		toX, toY = 61, 29
	}
	line(out, 42, 38, toX, toY, color.NRGBA{65, 42, 32, 255})
	line(out, 42, 37, toX, toY-1, color.NRGBA{160, 111, 64, 255})
	if pose == "hold" {
		line(out, toX, toY, toX, 51, color.NRGBA{160, 185, 194, 255})
		out.SetNRGBA(toX, 51, color.NRGBA{214, 63, 57, 255})
	}
	return out
}

func line(img *image.NRGBA, x0, y0, x1, y1 int, c color.NRGBA) {
	dx, dy := absInt(x1-x0), -absInt(y1-y0)
	sx, sy := -1, -1
	if x0 < x1 {
		sx = 1
	}
	if y0 < y1 {
		sy = 1
	}
	err := dx + dy
	for {
		img.SetNRGBA(x0, y0, c)
		if x0 == x1 && y0 == y1 {
			return
		}
		twice := err * 2
		if twice >= dy {
			err += dy
			x0 += sx
		}
		if twice <= dx {
			err += dx
			y0 += sy
		}
	}
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}
