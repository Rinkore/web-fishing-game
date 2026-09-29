// Build a reference-exact fixed-palette character from nine supplied PNGs.
// Only the first extraction needs -source-dir; reruns use committed cutouts.
// go run tools/build-twin-character.go -character twin -root . -source-dir C:/path/to/双马尾
// go run tools/build-twin-character.go -character pony -root . -source-dir C:/path/to/单马尾
package main

import (
	"errors"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
)

type pose struct {
	name, file string
	window     image.Rectangle
	anchorX    int
	anchorY    int
}

var twinPortraits = []pose{
	{"base", "红发双马尾登山角色.png", image.Rect(340, 360, 675, 730), 0, 0},
	{"stand", "双马尾背竿站立.png", image.Rect(320, 295, 680, 760), 0, 0},
	{"fish-stand", "双马尾站姿钓鱼.png", image.Rect(315, 305, 850, 740), 0, 0},
	{"sit", "双马尾坐姿钓鱼.png", image.Rect(300, 315, 830, 730), 0, 0},
}
var twinCasts = []pose{
	{"1", "双马尾抛竿01起势.png", image.Rect(90, 250, 1015, 730), 500, 683},
	{"2", "双马尾抛竿02蓄力.png", image.Rect(90, 250, 1015, 730), 515, 683},
	{"3", "双马尾抛竿03挥竿.png", image.Rect(90, 250, 1015, 730), 460, 685},
	{"4", "双马尾抛竿04出线.png", image.Rect(90, 245, 1015, 730), 425, 685},
	{"5", "双马尾抛竿05收势.png", image.Rect(90, 250, 1015, 730), 500, 683},
	{"idle", "双马尾站姿钓鱼.png", image.Rect(90, 250, 1015, 730), 470, 680},
}
var ponyPortraits = []pose{
	{"base", "白发单马尾吊带裤角色.png", image.Rect(350, 365, 650, 725), 0, 0},
	{"stand", "白发单马尾背竿站立.png", image.Rect(330, 310, 675, 730), 0, 0},
	{"fish-stand", "白发单马尾站姿钓鱼.png", image.Rect(320, 355, 760, 730), 0, 0},
	{"sit", "白发单马尾坐姿钓鱼.png", image.Rect(325, 345, 790, 725), 0, 0},
}
var ponyCasts = []pose{
	{"1", "白发单马尾抛竿01起势.png", image.Rect(320, 350, 880, 730), 490, 685},
	{"2", "白发单马尾抛竿02蓄力.png", image.Rect(170, 305, 700, 725), 500, 683},
	{"3", "白发单马尾抛竿03挥竿.png", image.Rect(285, 245, 1015, 725), 480, 682},
	{"4", "白发单马尾抛竿04出线.png", image.Rect(255, 265, 1015, 725), 450, 683},
	{"5", "白发单马尾抛竿05收势.png", image.Rect(350, 350, 835, 730), 500, 683},
	{"idle", "白发单马尾站姿钓鱼.png", image.Rect(325, 350, 770, 730), 480, 690},
}

func posesFor(character string) ([]pose, []pose, error) {
	switch character {
	case "twin":
		return twinPortraits, twinCasts, nil
	case "pony":
		return ponyPortraits, ponyCasts, nil
	default:
		return nil, nil, fmt.Errorf("unknown character %q", character)
	}
}

func main() {
	root := flag.String("root", ".", "repository root")
	source := flag.String("source-dir", "", "directory holding the nine reference images")
	character := flag.String("character", "twin", "character id: twin or pony")
	flag.Parse()
	if err := run(*root, *source, *character); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(root, source, character string) error {
	portraits, casts, err := posesFor(character)
	if err != nil {
		return err
	}
	portraitDir := filepath.Join(root, "frontend", "assets", "ui", "char")
	castDir := filepath.Join(root, "frontend", "assets", "ui", "chars")
	for _, dir := range []string{portraitDir, castDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	for _, p := range portraits {
		path := filepath.Join(portraitDir, character+"-"+p.name+".png")
		if source != "" {
			original, err := read(filepath.Join(source, p.file))
			if err != nil {
				return err
			}
			cut, err := extract(original, p.window)
			if err != nil {
				return fmt.Errorf("%s: %w", p.name, err)
			}
			if err := save(path, cut); err != nil {
				return err
			}
		} else if _, err := os.Stat(path); err != nil {
			return err
		}
	}
	sit, err := read(filepath.Join(portraitDir, character+"-sit.png"))
	if err != nil {
		return err
	}
	if err := save(filepath.Join(portraitDir, character+"-boat.png"), boatPose(sit)); err != nil {
		return err
	}
	for _, p := range casts {
		path := filepath.Join(castDir, character+"-cast-"+p.name+".png")
		if source != "" {
			original, err := read(filepath.Join(source, p.file))
			if err != nil {
				return err
			}
			cut, err := extract(original, p.window)
			if err != nil {
				return fmt.Errorf("cast %s: %w", p.name, err)
			}
			if err := save(path, placeCast(cut, p.anchorX, p.anchorY, character)); err != nil {
				return err
			}
		} else if _, err := os.Stat(path); err != nil {
			return err
		}
	}
	fmt.Printf("%s: four reference poses, one boat cutout, five casts and one map idle pose\n", character)
	return nil
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
func save(path string, img image.Image) error {
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
	low, high := min(p.R, min(p.G, p.B)), max(p.R, max(p.G, p.B))
	return low >= 236 && high-low <= 24
}

func extract(src *image.NRGBA, window image.Rectangle) (*image.NRGBA, error) {
	window = window.Intersect(src.Bounds())
	if window.Empty() {
		return nil, errors.New("reference crop is empty")
	}
	w, h := window.Dx(), window.Dy()
	background := make([]bool, w*h)
	queue := make([]int, 0, 2*(w+h))
	add := func(x, y int) {
		if x < 0 || y < 0 || x >= w || y >= h {
			return
		}
		i := y*w + x
		if background[i] || !paper(src.NRGBAAt(window.Min.X+x, window.Min.Y+y)) {
			return
		}
		background[i] = true
		queue = append(queue, i)
	}
	for x := 0; x < w; x++ {
		add(x, 0)
		add(x, h-1)
	}
	for y := 0; y < h; y++ {
		add(0, y)
		add(w-1, y)
	}
	for head := 0; head < len(queue); head++ {
		i := queue[head]
		x, y := i%w, i/w
		add(x-1, y)
		add(x+1, y)
		add(x, y-1)
		add(x, y+1)
	}
	// Keep components large enough to be art, including one-pixel diagonal
	// fishing line segments; 8-neighbour connectivity joins those diagonals.
	seen := make([]bool, w*h)
	keep := make([]bool, w*h)
	for start := range seen {
		if seen[start] || background[start] {
			continue
		}
		component := []int{start}
		seen[start] = true
		for head := 0; head < len(component); head++ {
			i := component[head]
			x, y := i%w, i/w
			for dy := -1; dy <= 1; dy++ {
				for dx := -1; dx <= 1; dx++ {
					if dx == 0 && dy == 0 {
						continue
					}
					nx, ny := x+dx, y+dy
					if nx < 0 || ny < 0 || nx >= w || ny >= h {
						continue
					}
					next := ny*w + nx
					if seen[next] || background[next] {
						continue
					}
					seen[next] = true
					component = append(component, next)
				}
			}
		}
		if len(component) >= 6 {
			for _, i := range component {
				keep[i] = true
			}
		}
	}
	left, top, right, bottom := w, h, -1, -1
	for i, ok := range keep {
		if ok {
			x, y := i%w, i/w
			left = min(left, x)
			top = min(top, y)
			right = max(right, x)
			bottom = max(bottom, y)
		}
	}
	if right < left {
		return nil, errors.New("no character foreground detected")
	}
	left = max(0, left-3)
	top = max(0, top-3)
	right = min(w-1, right+3)
	bottom = min(h-1, bottom+3)
	out := image.NewNRGBA(image.Rect(window.Min.X+left, window.Min.Y+top, window.Min.X+right+1, window.Min.Y+bottom+1))
	for y := top; y <= bottom; y++ {
		for x := left; x <= right; x++ {
			if keep[y*w+x] {
				out.SetNRGBA(window.Min.X+x, window.Min.Y+y, src.NRGBAAt(window.Min.X+x, window.Min.Y+y))
			}
		}
	}
	return out, nil
}

func boatPose(src *image.NRGBA) *image.NRGBA {
	out := image.NewNRGBA(src.Bounds())
	copy(out.Pix, src.Pix)
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	for y := h * 74 / 100; y < h; y++ {
		for x := 0; x < w*58/100; x++ {
			out.SetNRGBA(x, y, color.NRGBA{})
		}
	}
	return out
}

func placeCast(cut *image.NRGBA, footX, footY int, character string) *image.NRGBA {
	const width, height = 1000, 400
	out := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			sx := footX + int(math.Round(float64(x-480)/.82))
			sy := footY + int(math.Round(float64(y-340)/.82))
			if (image.Pt(sx, sy)).In(cut.Bounds()) {
				p := cut.NRGBAAt(sx, sy)
				// A rod/line arc can enclose a patch of pure paper during flood-fill.
				// Preserve the pale face, but remove those enclosed white pockets.
				paleSubject := sx >= footX-105 && sx <= footX+105 && sy >= 400 && sy <= 550
				if character == "pony" {
					paleSubject = sx >= footX-180 && sx <= footX+145 && sy >= 360 && sy <= 570
				}
				if p.A > 0 && (!paper(p) || paleSubject) {
					out.SetNRGBA(x, y, p)
				}
			}
		}
	}
	return out
}
