// Package rules implements native Go calculations compatible with the shared v0.21.4 rules.
package rules

import (
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// Expressions are compiled once per configuration version. The bounds are an
// intentional configuration constraint; no executable JavaScript is accepted.
const MaxExpressionBytes = 4096
const maxNodes = 512
const maxDepth = 64

type Expression struct {
	eval func(map[string]float64) float64
}

func (e *Expression) Eval(vars map[string]float64) float64 { return e.eval(vars) }

type exprParser struct {
	source            string
	pos, depth, nodes int
	vars              map[string]bool
}
type evaluator = func(map[string]float64) float64

var numberToken = regexp.MustCompile(`^[0-9]*\.?[0-9]+`)
var identifierToken = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*`)
var errExpression = errors.New("invalid or over-complex expression")

func Compile(source string, vars []string) (expr *Expression, err error) {
	defer func() {
		if recover() != nil {
			expr = nil
			err = errExpression
		}
	}()
	if len(source) > MaxExpressionBytes {
		return nil, errExpression
	}
	p := exprParser{source: strings.TrimSpace(source), vars: map[string]bool{}}
	probe := map[string]float64{}
	for _, v := range vars {
		p.vars[v] = true
		probe[v] = 1
	}
	f := p.expression()
	p.ws()
	if p.pos != len(p.source) || !finite(f(probe)) {
		return nil, errExpression
	}
	return &Expression{f}, nil
}
func (p *exprParser) ws() {
	rest := p.source[p.pos:]
	p.pos += len(rest) - len(strings.TrimLeftFunc(rest, func(r rune) bool { return unicode.IsSpace(r) || r == '\uFEFF' }))
}
func (p *exprParser) take(c byte) bool {
	p.ws()
	if p.pos < len(p.source) && p.source[p.pos] == c {
		p.pos++
		return true
	}
	return false
}
func (p *exprParser) count() {
	p.nodes++
	if p.nodes > maxNodes {
		panic(errExpression)
	}
}
func (p *exprParser) expression() evaluator {
	f := p.term()
	for {
		var op byte
		if p.take('+') {
			op = '+'
		} else if p.take('-') {
			op = '-'
		} else {
			return f
		}
		p.count()
		a, b := f, p.term()
		f = func(v map[string]float64) float64 {
			if op == '+' {
				return a(v) + b(v)
			}
			return a(v) - b(v)
		}
	}
}
func (p *exprParser) term() evaluator {
	f := p.factor()
	for {
		var op byte
		if p.take('*') {
			op = '*'
		} else if p.take('/') {
			op = '/'
		} else if p.take('%') {
			op = '%'
		} else {
			return f
		}
		p.count()
		a, b := f, p.factor()
		f = func(v map[string]float64) float64 {
			switch op {
			case '*':
				return a(v) * b(v)
			case '/':
				return a(v) / b(v)
			default:
				return math.Mod(a(v), b(v))
			}
		}
	}
}
func (p *exprParser) factor() evaluator {
	p.depth++
	defer func() { p.depth-- }()
	p.count()
	if p.depth > maxDepth {
		panic(errExpression)
	}
	if p.take('-') {
		f := p.factor()
		return func(v map[string]float64) float64 { return -f(v) }
	}
	if p.take('+') {
		return p.factor()
	}
	if p.take('(') {
		f := p.expression()
		if !p.take(')') {
			panic(errExpression)
		}
		return f
	}
	p.ws()
	if token := numberToken.FindString(p.source[p.pos:]); token != "" {
		p.pos += len(token)
		n, _ := strconv.ParseFloat(token, 64)
		return func(map[string]float64) float64 { return n }
	}
	name := identifierToken.FindString(p.source[p.pos:])
	if name == "" {
		panic(errExpression)
	}
	p.pos += len(name)
	if p.take('(') {
		switch name {
		case "min", "max", "floor", "ceil", "round", "abs", "clamp":
		default:
			panic(errExpression)
		}
		args := []evaluator{}
		if !p.take(')') {
			for {
				args = append(args, p.expression())
				if !p.take(',') {
					break
				}
			}
			if !p.take(')') {
				panic(errExpression)
			}
		}
		return func(v map[string]float64) float64 {
			a := make([]float64, len(args))
			for i, f := range args {
				a[i] = f(v)
			}
			return callMath(name, a)
		}
	}
	if !p.vars[name] {
		panic(errExpression)
	}
	return func(v map[string]float64) float64 {
		n := v[name]
		if math.IsNaN(n) {
			return 0
		}
		return n
	}
}
func callMath(name string, a []float64) float64 {
	if name == "min" || name == "max" {
		n := math.Inf(1)
		if name == "max" {
			n = math.Inf(-1)
		}
		for _, v := range a {
			if name == "min" {
				n = math.Min(n, v)
			} else {
				n = math.Max(n, v)
			}
		}
		return n
	}
	get := func(i int) float64 {
		if i < len(a) {
			return a[i]
		}
		return math.NaN()
	}
	switch name {
	case "floor":
		return math.Floor(get(0))
	case "ceil":
		return math.Ceil(get(0))
	case "round":
		return Round(get(0))
	case "abs":
		return math.Abs(get(0))
	default:
		return clamp(get(0), get(1), get(2))
	}
}

// Round matches Math.round, including ties toward positive infinity and -0.
func Round(x float64) float64 {
	if !finite(x) || x == 0 {
		return x
	}
	lo := math.Floor(x)
	if x-lo >= .5 {
		lo++
	}
	if lo == 0 && x < 0 {
		return math.Copysign(0, -1)
	}
	return lo
}
func finite(x float64) bool           { return !math.IsNaN(x) && !math.IsInf(x, 0) }
func clamp(x, lo, hi float64) float64 { return math.Min(hi, math.Max(lo, x)) }
