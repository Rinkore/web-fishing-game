// Command fishgen partitions every reference fish PNG into lossless anatomical
// layers and writes the shared browser/server genetics catalog.
//
// Run from server-go with: go run ./cmd/fishgen -root ..
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type profile struct{ family, notes string }

var profiles = map[string]profile{
	"amberjack":    {"streamlined", "蓝青长纺锤身；金色背腹鳍和月牙尾；金色侧线；银腹"},
	"amberlobster": {"lobster", "橙琥珀分节甲壳；长触角；步足；分节腹与尾扇"},
	"arapaima":     {"elongate", "红褐长筒身；朱红竖鳞缘；深红圆尾；小黑眼"},
	"arowana":      {"elongate", "金红长身；大块网格金鳞；后置低背鳍及臀鳍；圆尾；上翘吻与双须"},
	"bass":         {"deep", "橄榄绿宽身；高背鳍；夸张张口；黑眼；深色尾柄"},
	"bighead":      {"deep", "灰绿大头宽身；方块杂斑；白色大鳃腹；黑眼；短尾"},
	"blackbass":    {"streamlined", "橄榄长椭圆身；白色侧线与浅腹；大口；尖背鳍；扇尾"},
	"blackcarp":    {"deep", "深蓝宽椭圆身；高背鳍；蓝黑头；黑眼；叉尾"},
	"bluefin":      {"streamlined", "藏蓝纺锤身；银腹；两块金黄鳍；叉尾；黑眼"},
	"bream":        {"deep", "灰绿高菱形身；浅色宽腹；尖背鳍与臀鳍；短扇尾"},
	"carp":         {"deep", "橙红高背；橙色腹鳍；黑眼；大鳃盖；口须；叉尾"},
	"catfish":      {"streamlined", "蓝灰椭圆身；深头；短背鳍；小扇尾；低对比口须"},
	"cobia":        {"streamlined", "褐灰长身；深色竖带；尖背鳍；叉尾；浅鳃盖"},
	"coelacanth":   {"deep", "钢蓝短厚身；浅蓝块斑；肉质叶状成对鳍；三叶式尾部"},
	"croaker":      {"streamlined", "亮金黄色纺锤身；高背鳍；浅金腹；叉尾；黑眼"},
	"crucian":      {"deep", "金褐宽身；大鳃盖；暗金高背鳍；扇形尾；浅腹"},
	"culter":       {"elongate", "银灰长身；翘起尖吻；白鳃盖；高背鳍；叉尾"},
	"dragonfish":   {"elongate", "墨蓝细长身；头顶发光钓灯；橙色牙口；暗色叉尾"},
	"dragonpearl":  {"orb", "青绿色圆珠；白色高光；金色离散环绕光点"},
	"ghostray":     {"ray", "银蓝菱形鳐盘；白色翼缘；中央黑眼；细长鞭尾；周围幽光"},
	"giantquid":    {"squid", "粉红长胴体；侧鳍；白眼黑瞳；左侧长触腕与吸盘块"},
	"grass":        {"elongate", "橄榄长方身；浅色长腹；低背鳍；竖黑眼；叉尾"},
	"grouper":      {"deep", "褐灰厚身；不规则深斑；厚唇；高背鳍；扇尾"},
	"halibut":      {"flat", "沙褐扁椭圆身；褐色散点；边缘连续鳍；小头；短尾"},
	"jackmack":     {"streamlined", "蓝青长身；金色纵侧线；银腹；金色高背鳍和叉尾"},
	"koi":          {"streamlined", "金黄底色；乳白与橙色大斑；黑眼；金叉尾"},
	"leviathan":    {"streamlined", "青蓝巨身；浅蓝腹；金色角冠与棘背；金边叉尾；口须"},
	"loach":        {"elongate", "棕色极细长身；浅色纵线；短须；小眼；低鳍短尾"},
	"mackerel":     {"elongate", "蓝灰长身；五条深蓝竖纹；浅腹；叉尾"},
	"mahimahi":     {"streamlined", "青绿色长身；高额；蓝色大块斑；长背鳍；叉尾"},
	"mandarin":     {"deep", "草绿短身；深绿散斑；高尖背鳍；浅腹；短扇尾"},
	"megamouth":    {"shark", "灰蓝鲨形身；宽大平口；三道鳃裂；三角背鳍；异形叉尾"},
	"minnow":       {"elongate", "棕金小长身；宽黑纵向头鳃带；方背鳍与腹鳍；小叉尾"},
	"moonkoi":      {"streamlined", "月白长身；淡蓝块斑；蓝色轮廓；白色叉尾与外光"},
	"mullet":       {"elongate", "银灰长身；水平灰侧线；双背部起伏；尖叉尾"},
	"octo":         {"octopus", "粉紫圆头；白眼；下方八腕轮廓；腕间空隙与吸盘块"},
	"pearl":        {"shell", "紫色双片贝壳；放射壳纹；中央乳白珍珠与高光"},
	"riverperch":   {"deep", "橄榄黄高身；多条黑色竖带；橙红腹尾鳍；黑眼"},
	"rubysnapper":  {"streamlined", "宝石红身；浅粉腹；金边大黑眼；尖背鳍；红叉尾"},
	"sardine":      {"elongate", "蓝色长背；银白腹；黑眼白鳃；蓝色腹鳍与叉尾"},
	"seabass":      {"streamlined", "银灰宽身；白腹；深灰高背鳍；黑眼；叉尾"},
	"silvercarp":   {"deep", "银灰宽厚身；大白鳃盖；小眼；三角背鳍；短叉尾"},
	"squid":        {"squid", "乳粉长胴体；白眼黑瞳；左侧细长触腕；侧鳍"},
	"sturgeon":     {"elongate", "灰褐细长身；尖吻；上下成排白色骨板；异形短尾"},
	"sunfish":      {"round", "蓝灰近圆高身；浅色横腹；上下对称高鳍；截短尾缘；小口"},
	"swordfish":    {"streamlined", "蓝色流线身；长剑吻；高尖背鳍；小黑眼；短尾"},
	"tilapia":      {"deep", "灰绿宽身；四条宽黑竖带；浅腹；长棘背鳍；短尾"},
	"tuna":         {"streamlined", "深蓝粗纺锤身；金色背鳍及小离鳍；深蓝叉尾；小眼"},
	"voltaiceel":   {"eel", "蜿蜒深蓝鳗身；青蓝电弧斑纹；连续尾缘；无普通分离尾鳍"},
	"white":        {"elongate", "亮银细长身；浅灰平背；竖黑眼；窄尾柄与叉尾"},
	"yellowcat":    {"streamlined", "棕金身；深背棘；长口须；方鳃部；金色叉尾"},
	"yellowcheek":  {"elongate", "黄绿长身；金黄颊；浅腹；尖背鳍；叉尾"},
}

var loci = []string{"body", "head", "dorsal", "ventral", "tail", "skin"}

type species struct {
	ID             string            `json:"id"`
	Name           string            `json:"name"`
	Family         string            `json:"family"`
	Group          string            `json:"group"`
	BreedGroup     string            `json:"breedGroup"`
	BreedNote      string            `json:"breedNote"`
	Notes          string            `json:"notes"`
	Width          int               `json:"width"`
	Height         int               `json:"height"`
	BBox           []int             `json:"bbox"`
	Bounds         map[string][]int  `json:"bounds"`
	SHA256         string            `json:"sha256"`
	LayerSHA256    map[string]string `json:"layerSha256"`
	Rank           map[string]int    `json:"rank"`
	TailEnabled    bool              `json:"tailEnabled"`
	ReferenceExact bool              `json:"referenceExact"`
}

type catalog struct {
	Version   int                `json:"version"`
	Loci      []string           `json:"loci"`
	Labels    map[string]string  `json:"labels"`
	Mutations map[string]any     `json:"mutations"`
	Species   map[string]species `json:"species"`
}

func main() {
	root := flag.String("root", "..", "repository root")
	flag.Parse()
	if err := run(filepath.Clean(*root)); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(root string) error {
	names, err := itemNames(filepath.Join(root, "frontend", "js", "data.js"))
	if err != nil {
		return err
	}
	source := filepath.Join(root, "frontend", "assets", "fish")
	out := filepath.Join(root, "frontend", "assets", "genetics")
	if err = os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	entries, err := filepath.Glob(filepath.Join(source, "*.png"))
	if err != nil {
		return err
	}
	sort.Strings(entries)
	c := catalog{Version: 2, Loci: loci, Labels: map[string]string{
		"body": "体型骨架", "head": "头部（眼、吻、鳃、须）", "dorsal": "背部（背鳍、棘、冠）", "ventral": "腹部（腹鳍、足、腕）", "tail": "尾部", "skin": "体表（底色、纹理、鳞、发光）",
	}, Mutations: map[string]any{
		"albino": map[string]string{"label": "白化红眼", "allele": "a", "wild": "A", "dominance": "recessive", "description": "aa 表达，Aa 携带；减少体色并将眼部染红"},
		"star":   map[string]string{"label": "星点鳞", "allele": "s", "wild": "S", "dominance": "recessive", "description": "ss 表达，Ss 携带；身体表面出现金色星点"},
		"veil":   map[string]string{"label": "流纱尾", "allele": "V", "wild": "v", "dominance": "dominant", "description": "Vv / VV 表达；仅有独立尾鳍的体型可表达"},
		"glow":   map[string]string{"label": "荧光边缘", "allele": "G", "wild": "g", "dominance": "dominant", "description": "Gg / GG 表达；沿身体外轮廓产生青色光点"},
	}, Species: map[string]species{}}
	for index, path := range entries {
		id := strings.TrimSuffix(filepath.Base(path), ".png")
		p, ok := profiles[id]
		if !ok {
			return fmt.Errorf("missing profile for %s", id)
		}
		item, buildErr := buildSpecies(path, out, id, names[id], p, index, len(entries))
		if buildErr != nil {
			return buildErr
		}
		c.Species[id] = item
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	for _, target := range []string{filepath.Join(out, "catalog.json"), filepath.Join(root, "server-go", "internal", "modules", "breeding", "catalog.json")} {
		if err = os.WriteFile(target, data, 0o644); err != nil {
			return err
		}
	}
	fmt.Printf("%d reference sprites partitioned and losslessly verified\n", len(entries))
	return nil
}

func itemNames(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	re := regexp.MustCompile(`id:\s*'([^']+)'\s*,\s*name:\s*'([^']+)'`)
	out := map[string]string{}
	for _, match := range re.FindAllSubmatch(data, -1) {
		out[string(match[1])] = string(match[2])
	}
	return out, nil
}

func buildSpecies(path, out, id, name string, p profile, index, count int) (species, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return species{}, err
	}
	decoded, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		return species{}, err
	}
	bounds := decoded.Bounds()
	source := image.NewNRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	for y := 0; y < bounds.Dy(); y++ {
		for x := 0; x < bounds.Dx(); x++ {
			source.SetNRGBA(x, y, color.NRGBAModel.Convert(decoded.At(bounds.Min.X+x, bounds.Min.Y+y)).(color.NRGBA))
		}
	}
	bbox := alphaBounds(source)
	if bbox == nil {
		return species{}, fmt.Errorf("empty reference %s", id)
	}
	layers := map[string]*image.NRGBA{}
	for _, locus := range loci[1:] {
		layers[locus] = image.NewNRGBA(source.Bounds())
	}
	bw, bh := float64(bbox[2]-bbox[0]), float64(bbox[3]-bbox[1])
	for y := 0; y < source.Bounds().Dy(); y++ {
		for x := 0; x < source.Bounds().Dx(); x++ {
			px := source.NRGBAAt(x, y)
			if px.A == 0 {
				continue
			}
			u, v := float64(x-bbox[0])/bw, float64(y-bbox[1])/bh
			locus := region(p.family, u, v)
			layers[locus].SetNRGBA(x, y, px)
		}
	}
	rebuilt := image.NewNRGBA(source.Bounds())
	layerBounds, layerHashes := map[string][]int{}, map[string]string{}
	for _, locus := range loci[1:] {
		layer := layers[locus]
		for y := 0; y < layer.Bounds().Dy(); y++ {
			for x := 0; x < layer.Bounds().Dx(); x++ {
				if px := layer.NRGBAAt(x, y); px.A != 0 {
					rebuilt.SetNRGBA(x, y, px)
				}
			}
		}
		layerBounds[locus] = alphaBounds(layer)
		var encoded bytes.Buffer
		encoder := png.Encoder{CompressionLevel: png.BestCompression}
		if err = encoder.Encode(&encoded, layer); err != nil {
			return species{}, err
		}
		target := filepath.Join(out, id+"-"+locus+".png")
		if err = os.WriteFile(target, encoded.Bytes(), 0o644); err != nil {
			return species{}, err
		}
		h := sha256.Sum256(encoded.Bytes())
		layerHashes[locus] = hex.EncodeToString(h[:])
	}
	if !visibleEqual(source, rebuilt) {
		return species{}, fmt.Errorf("lossless reconstruction failed for %s", id)
	}
	group := map[string]string{"lobster": "crustacean", "squid": "cephalopod", "octopus": "cephalopod", "shell": "shell", "orb": "orb"}[p.family]
	if group == "" {
		group = "fish"
	}
	breedGroup, breedNote := id, "仅允许同种繁育"
	switch id {
	case "carp":
		breedGroup, breedNote = "cyprinid-carp", "鲤鱼品系；可与锦鲤、鲫鱼形成现实记录中的杂交组合"
	case "koi":
		breedGroup, breedNote = "cyprinid-carp", "锦鲤按鲤鱼观赏品系处理"
	case "crucian":
		breedGroup, breedNote = "cyprinid-carp", "鲫鱼与鲤鱼存在现实记录中的杂交组合"
	case "bighead":
		breedGroup, breedNote = "hypophthalmichthys", "鳙鱼可与鲢鱼形成现实记录中的杂交组合"
	case "silvercarp":
		breedGroup, breedNote = "hypophthalmichthys", "鲢鱼可与鳙鱼形成现实记录中的杂交组合"
	}
	if name == "" {
		name = id
	}
	h := sha256.Sum256(raw)
	rank := map[string]int{}
	for j, locus := range loci {
		rank[locus] = 1 + ((index*17 + j*13) % count)
	}
	tail := p.family == "streamlined" || p.family == "elongate" || p.family == "deep" || p.family == "shark" || p.family == "lobster"
	return species{ID: id, Name: name, Family: p.family, Group: group, BreedGroup: breedGroup, BreedNote: breedNote, Notes: p.notes, Width: bounds.Dx(), Height: bounds.Dy(), BBox: bbox, Bounds: layerBounds, SHA256: hex.EncodeToString(h[:]), LayerSHA256: layerHashes, Rank: rank, TailEnabled: tail, ReferenceExact: true}, nil
}

func region(family string, u, v float64) string {
	if family == "squid" || family == "octopus" {
		if (family == "squid" && u < .38) || (family == "octopus" && v > .58) {
			return "ventral"
		}
		if u > .38 && u < .53 {
			return "head"
		}
		return "skin"
	}
	if family == "shell" || family == "orb" || family == "ray" || family == "eel" || family == "flat" || family == "round" {
		if family != "shell" && family != "orb" && u < .25 && v > .3 && v < .72 {
			return "head"
		}
		return "skin"
	}
	if u >= .77 {
		return "tail"
	}
	if u < .29 {
		return "head"
	}
	if v < .29 {
		return "dorsal"
	}
	if v > .73 {
		return "ventral"
	}
	return "skin"
}

func alphaBounds(img *image.NRGBA) []int {
	x0, y0, x1, y1 := img.Bounds().Dx(), img.Bounds().Dy(), -1, -1
	for y := 0; y < img.Bounds().Dy(); y++ {
		for x := 0; x < img.Bounds().Dx(); x++ {
			if img.NRGBAAt(x, y).A != 0 {
				if x < x0 {
					x0 = x
				}
				if y < y0 {
					y0 = y
				}
				if x > x1 {
					x1 = x
				}
				if y > y1 {
					y1 = y
				}
			}
		}
	}
	if x1 < 0 {
		return nil
	}
	return []int{x0, y0, x1 + 1, y1 + 1}
}

func visibleEqual(a, b *image.NRGBA) bool {
	if a.Bounds() != b.Bounds() {
		return false
	}
	for y := 0; y < a.Bounds().Dy(); y++ {
		for x := 0; x < a.Bounds().Dx(); x++ {
			pa, pb := a.NRGBAAt(x, y), b.NRGBAAt(x, y)
			if pa.A != pb.A || pa.A != 0 && pa != pb {
				return false
			}
		}
	}
	return true
}
