package analytics

import (
	"bytes"
	"compress/zlib"
	_ "embed"
	"encoding/binary"
	"fmt"
	"slices"
	"strings"
	"unicode/utf16"
)

// Embedded DejaVu Sans (regular + bold, Bitstream Vera license, see fonts/LICENSE), subset to
// Latin (incl. č ć đ š ž), Latin Extended-B, Cyrillic, punctuation and currency symbols with:
//
//	pyftsubset DejaVuSans.ttf --unicodes=U+0020-007E,U+00A0-024F,U+0400-045F,U+2010-2027,
//	  U+2030-203A,U+2044,U+20A0-20C0,U+2116,U+2122,U+2190-2193,U+2212,U+2248,U+2260,U+2264,
//	  U+2265,U+202F,U+FFFD --layout-features= --no-hinting --desubroutinize
//	  --drop-tables+=GSUB,GPOS,GDEF,kern
//
// Characters outside the subset render as U+FFFD.

//go:embed fonts/DejaVuSans.ttf
var dejaVuRegular []byte

//go:embed fonts/DejaVuSans-Bold.ttf
var dejaVuBold []byte

var pdfFonts = [2]*ttFont{mustFont("DejaVuSans", dejaVuRegular), mustFont("DejaVuSans-Bold", dejaVuBold)}

type ttFont struct {
	name                      string
	data                      []byte
	cmap                      map[rune]uint16
	adv                       []int // advance per glyph in 1/1000 em
	bbox                      [4]int
	ascent, descent, fallback int
}

func mustFont(name string, data []byte) *ttFont {
	f, err := parseTTF(name, data)
	if err != nil {
		panic(fmt.Sprintf("font %s: %v", name, err))
	}
	return f
}

// parseTTF reads the tables a CIDFontType2 needs: head, hhea, hmtx and a format 4 cmap.
func parseTTF(name string, d []byte) (*ttFont, error) {
	u16 := func(o int) int { return int(binary.BigEndian.Uint16(d[o:])) }
	i16 := func(o int) int { return int(int16(binary.BigEndian.Uint16(d[o:]))) }
	tables := map[string]int{}
	for i := range u16(4) {
		rec := 12 + 16*i
		tables[string(d[rec:rec+4])] = int(binary.BigEndian.Uint32(d[rec+8:]))
	}
	for _, t := range []string{"head", "hhea", "hmtx", "cmap"} {
		if _, ok := tables[t]; !ok {
			return nil, fmt.Errorf("missing %s table", t)
		}
	}
	head, hhea, hmtx, cmap := tables["head"], tables["hhea"], tables["hmtx"], tables["cmap"]
	em := u16(head + 18)
	scale := func(v int) int { return v * 1000 / em }
	f := &ttFont{name: name, data: d, cmap: map[rune]uint16{},
		bbox:   [4]int{scale(i16(head + 36)), scale(i16(head + 38)), scale(i16(head + 40)), scale(i16(head + 42))},
		ascent: scale(i16(hhea + 4)), descent: scale(i16(hhea + 6))}
	nh := u16(hhea + 34)
	for g := range nh {
		f.adv = append(f.adv, scale(u16(hmtx+4*g)))
	}
	sub := -1
	for i := range u16(cmap + 2) {
		rec := cmap + 4 + 8*i
		if u16(rec) == 3 && u16(rec+2) == 1 {
			sub = cmap + int(binary.BigEndian.Uint32(d[rec+4:]))
		}
	}
	if sub < 0 || u16(sub) != 4 {
		return nil, fmt.Errorf("no (3,1) format 4 cmap")
	}
	seg := u16(sub+6) / 2
	ends, starts, deltas, ranges := sub+14, sub+16+2*seg, sub+16+4*seg, sub+16+6*seg
	for s := range seg {
		end, start, delta, ro := u16(ends+2*s), u16(starts+2*s), u16(deltas+2*s), u16(ranges+2*s)
		for c := start; c <= end && c != 0xFFFF; c++ {
			g := 0
			if ro == 0 {
				g = (c + delta) & 0xFFFF
			} else if p := ranges + 2*s + ro + 2*(c-start); p+2 <= len(d) {
				if g = u16(p); g != 0 {
					g = (g + delta) & 0xFFFF
				}
			}
			if g != 0 {
				f.cmap[rune(c)] = uint16(g)
			}
		}
	}
	f.fallback = int(f.cmap['�'])
	return f, nil
}

func (f *ttFont) width(g uint16) int {
	if int(g) < len(f.adv) {
		return f.adv[g]
	}
	return f.adv[len(f.adv)-1] // glyphs past numberOfHMetrics share the last advance
}

// pdfLine is one line of report text; bold lines use the bold face.
type pdfLine struct {
	text string
	bold bool
}

// writePDF lays out lines on A4 pages (60 per page) with the embedded fonts as Identity-H
// Type0 fonts plus ToUnicode maps, so every character renders and extracts back as text.
// ponytail: hand-written single-column writer; switch to a layout library if charts are needed.
func writePDF(lines []pdfLine) []byte {
	const perPage = 60
	used := [2]map[uint16]rune{{}, {}}
	enc := func(fi int, s string) string {
		f := pdfFonts[fi]
		var b strings.Builder
		b.WriteByte('<')
		for _, r := range s {
			if r < 32 {
				r = ' '
			}
			g, ok := f.cmap[r]
			if !ok {
				g, r = uint16(f.fallback), '�'
			}
			used[fi][g] = r
			fmt.Fprintf(&b, "%04X", g)
		}
		b.WriteByte('>')
		return b.String()
	}
	var contents []string
	for i := 0; i < len(lines) || i == 0; i += perPage {
		var c strings.Builder
		c.WriteString("BT 40 800 Td 12 TL\n")
		cur := -1
		for _, l := range lines[i:min(i+perPage, len(lines))] {
			fi := 0
			if l.bold {
				fi = 1
			}
			if fi != cur {
				fmt.Fprintf(&c, "/F%d 9 Tf\n", fi+1)
				cur = fi
			}
			c.WriteString(enc(fi, l.text) + " '\n")
		}
		c.WriteString("ET")
		contents = append(contents, c.String())
	}

	var objs []string
	add := func(o string) int { objs = append(objs, o); return len(objs) }
	stream := func(dict string, data []byte, compress bool) int {
		if compress {
			var z bytes.Buffer
			w := zlib.NewWriter(&z)
			_, _ = w.Write(data)
			_ = w.Close()
			data, dict = z.Bytes(), dict+" /Filter /FlateDecode"
		}
		return add(fmt.Sprintf("<< %s /Length %d >>\nstream\n%s\nendstream", dict, len(data), data))
	}
	add("<< /Type /Catalog /Pages 2 0 R >>")
	add("") // pages, filled in below
	var fontRefs [2]int
	for fi, f := range pdfFonts {
		file := stream(fmt.Sprintf("/Length1 %d", len(f.data)), f.data, true)
		desc := add(fmt.Sprintf("<< /Type /FontDescriptor /FontName /%s /Flags 32 /FontBBox [%d %d %d %d] /ItalicAngle 0 /Ascent %d /Descent %d /CapHeight %d /StemV 80 /FontFile2 %d 0 R >>",
			f.name, f.bbox[0], f.bbox[1], f.bbox[2], f.bbox[3], f.ascent, f.descent, f.ascent, file))
		gids := make([]uint16, 0, len(used[fi]))
		for g := range used[fi] {
			gids = append(gids, g)
		}
		slices.Sort(gids)
		var w, cm strings.Builder
		for i, g := range gids {
			fmt.Fprintf(&w, "%d [%d] ", g, f.width(g))
			if i%100 == 0 {
				fmt.Fprintf(&cm, "%d beginbfchar\n", min(100, len(gids)-i))
			}
			fmt.Fprintf(&cm, "<%04X> <", g)
			for _, u := range utf16.Encode([]rune{used[fi][g]}) {
				fmt.Fprintf(&cm, "%04X", u)
			}
			cm.WriteString(">\n")
			if i%100 == 99 || i == len(gids)-1 {
				cm.WriteString("endbfchar\n")
			}
		}
		cid := add(fmt.Sprintf("<< /Type /Font /Subtype /CIDFontType2 /BaseFont /%s /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor %d 0 R /CIDToGIDMap /Identity /DW 1000 /W [%s] >>",
			f.name, desc, w.String()))
		toUni := stream("", []byte("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"+
			"/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n"+
			"1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n"+cm.String()+
			"endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend"), false)
		fontRefs[fi] = add(fmt.Sprintf("<< /Type /Font /Subtype /Type0 /BaseFont /%s /Encoding /Identity-H /DescendantFonts [%d 0 R] /ToUnicode %d 0 R >>",
			f.name, cid, toUni))
	}
	var kids []string
	for _, c := range contents {
		content := stream("", []byte(c), false)
		page := add(fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 %d 0 R /F2 %d 0 R >> >> /Contents %d 0 R >>",
			fontRefs[0], fontRefs[1], content))
		kids = append(kids, fmt.Sprintf("%d 0 R", page))
	}
	objs[1] = fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), len(kids))

	var b bytes.Buffer
	b.WriteString("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
	offsets := make([]int, len(objs))
	for i, o := range objs {
		offsets[i] = b.Len()
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", i+1, o)
	}
	xref := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n0000000000 65535 f \n", len(objs)+1)
	for _, off := range offsets {
		fmt.Fprintf(&b, "%010d 00000 n \n", off)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objs)+1, xref)
	return b.Bytes()
}
