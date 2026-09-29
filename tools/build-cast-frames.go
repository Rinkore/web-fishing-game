// Extract the five supplied cast poses and derive the 48 established looks.
// Source images are required only once; committed cast-base-*.png are reusable.
// go run tools/build-cast-frames.go -source-dir C:/Users/.../Downloads
// go run tools/build-cast-frames.go
package main

import (
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
)

type tone struct{ r, g, b uint8 }

var poseNames = []string{"01起势", "02蓄力", "03挥竿", "04出线", "05收势"}
var footX = []int{500, 515, 500, 475, 505}
var footY = []int{655, 655, 655, 668, 655}
var hairNames = []string{"orange", "teal", "red", "cream"}
var outfitNames = []string{"green", "yellow", "red", "blue"}
var skinNames = []string{"light", "tan", "dark"}
var hairs = map[string]tone{
	"orange": {190, 205, 244}, "teal": {129, 208, 219}, "red": {221, 148, 181}, "cream": {226, 225, 209},
}
var outfits = map[string]struct{ shirt, skirt, tie tone }{
	"green":  {tone{29, 30, 37}, tone{69, 68, 129}, tone{200, 56, 74}},
	"yellow": {tone{92, 71, 48}, tone{127, 91, 59}, tone{225, 181, 86}},
	"red":    {tone{93, 43, 61}, tone{125, 56, 91}, tone{238, 175, 190}},
	"blue":   {tone{40, 69, 99}, tone{50, 100, 141}, tone{105, 205, 214}},
}
var skinMultiplier = map[string]float64{"light": 1, "tan": .82, "dark": .58}

func main() {
	source := flag.String("source-dir", "", "directory containing the five 1024px reference poses")
	root := flag.String("root", ".", "repository root")
	flag.Parse()
	out := filepath.Join(*root, "frontend", "assets", "ui", "chars")
	if err := os.MkdirAll(out, 0o755); err != nil {
		panic(err)
	}
	for index, name := range poseNames {
		basePath := filepath.Join(out, fmt.Sprintf("cast-base-%d.png", index+1))
		var base *image.NRGBA
		var err error
		if *source != "" {
			base, err = read(filepath.Join(*source, "抛竿动作"+name+".png"))
			if err != nil {
				panic(err)
			}
			base = extract(base, index)
			if err = save(basePath, base); err != nil {
				panic(err)
			}
		} else {
			base, err = read(basePath)
			if err != nil {
				panic(err)
			}
		}
		for _, hair := range hairNames {
			for _, outfit := range outfitNames {
				for _, skin := range skinNames {
					path := filepath.Join(out, fmt.Sprintf("cast_%s_%s_%s_%d.png", hair, outfit, skin, index+1))
					if err = save(path, recolor(base, hair, outfit, skin)); err != nil {
						panic(err)
					}
				}
			}
		}
	}
	fmt.Println("five reference cast poses, 240 palette-matched frames")
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
	for y := 0; y < b.Dy(); y++ {
		for x := 0; x < b.Dx(); x++ {
			out.SetNRGBA(x, y, color.NRGBAModel.Convert(decoded.At(x+b.Min.X, y+b.Min.Y)).(color.NRGBA))
		}
	}
	return out, nil
}

func white(p color.NRGBA) bool {
	low, high := p.R, p.R
	for _, channel := range []uint8{p.G, p.B} {
		if channel < low {
			low = channel
		}
		if channel > high {
			high = channel
		}
	}
	return low >= 221 && high-low <= 34
}

func extract(src *image.NRGBA, pose int) *image.NRGBA {
	const width, height = 1000, 400
	b := src.Bounds()
	out := image.NewNRGBA(image.Rect(0, 0, width, height))
	// The crop window excludes the original image's subtle paper vignette while
	// retaining the left-hand dangling hook and the far-right cast line.
	x0, x1, y0, y1 := 190, min(b.Dx(), 980), 295, min(b.Dy(), 710)
	cw, ch := x1-x0, y1-y0
	background := make([]bool, cw*ch)
	queue := make([]int, 0, cw*2+ch*2)
	add := func(x, y int) {
		if x < 0 || y < 0 || x >= cw || y >= ch {
			return
		}
		i := y*cw + x
		if background[i] || !white(src.NRGBAAt(x0+x, y0+y)) {
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
	for y := 0; y < ch; y++ {
		for x := 0; x < cw; x++ {
			if background[y*cw+x] {
				continue
			}
			p := src.NRGBAAt(x0+x, y0+y)
			// A gradual matte keeps pale fishing line pixels from acquiring a hard
			// dark halo against the game's water and coast backgrounds.
			low, high := min(p.R, min(p.G, p.B)), max(p.R, max(p.G, p.B))
			if high-low < 20 && low > 195 {
				p.A = uint8(max(0, min(255, (235-int(low))*6)))
			}
			dx := x0 + x - footX[pose] + 480
			dy := y0 + y - footY[pose] + 330
			if dx >= 0 && dx < width && dy >= 0 && dy < height {
				out.SetNRGBA(dx, dy, p)
			}
		}
	}
	return out
}

func tint(p color.NRGBA, target, origin tone) color.NRGBA {
	base := float64(origin.r)*.3 + float64(origin.g)*.59 + float64(origin.b)*.11
	light := float64(p.R)*.3 + float64(p.G)*.59 + float64(p.B)*.11
	factor := light / max(1.0, base)
	clamp := func(v float64) uint8 { return uint8(min(255, max(0, int(v+.5)))) }
	return color.NRGBA{clamp(float64(target.r) * factor), clamp(float64(target.g) * factor), clamp(float64(target.b) * factor), p.A}
}

func recolor(base *image.NRGBA, hair, outfit, skin string) *image.NRGBA {
	out := image.NewNRGBA(base.Bounds())
	copy(out.Pix, base.Pix)
	if hair == "orange" && outfit == "green" && skin == "light" {
		return out
	}
	uniform := outfits[outfit]
	for y := 0; y < out.Bounds().Dy(); y++ {
		for x := 0; x < out.Bounds().Dx(); x++ {
			p := base.NRGBAAt(x, y)
			if p.A == 0 || x < 350 || x > 610 || y < 68 || y > 350 {
				continue
			}
			r, g, b := int(p.R), int(p.G), int(p.B)
			switch {
			case hair != "orange" && y < 240 && b > r+7 && b > g+5 && r > 95:
				p = tint(p, hairs[hair], hairs["orange"])
			case outfit != "green" && x < 555 && y > 185 && y < 300 && r > g*13/10 && r > b*12/10 && r > 90:
				p = tint(p, uniform.tie, outfits["green"].tie)
			case outfit != "green" && x < 555 && y > 270 && y < 335 && b > r+8 && b > g+3 && r < 145:
				p = tint(p, uniform.skirt, outfits["green"].skirt)
			case skin != "light" && x < 580 && y > 115 && r >= 155 && g >= 110 && b >= 75 && r > g+3 && g > b+3 && r < g*13/10:
				factor := skinMultiplier[skin]
				p.R = uint8(float64(p.R) * factor)
				p.G = uint8(float64(p.G) * (factor * .93))
				p.B = uint8(float64(p.B) * (factor * .89))
			case outfit != "green" && x < 555 && y > 185 && y < 310 && r < 100 && g < 100 && b < 110 && r+g+b > 48:
				p = tint(p, uniform.shirt, outfits["green"].shirt)
			}
			out.SetNRGBA(x, y, p)
		}
	}
	return out
}

func save(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(f, img)
}
