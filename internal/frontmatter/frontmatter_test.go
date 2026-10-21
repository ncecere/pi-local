package frontmatter

import "testing"

func TestParse(t *testing.T) {
	cases := []struct {
		name, in string
		want     map[string]string
		body     string
	}{
		{"plain", "---\nname: a\ndescription: Does a thing.\n---\n\nBody\n", map[string]string{"name": "a", "description": "Does a thing."}, "\nBody\n"},
		{"quoted", "---\ndescription: \"Fill \\\"forms\\\": merge\"\n---\nb", map[string]string{"description": `Fill "forms": merge`}, "b"},
		{"single quoted", "---\ndescription: 'it''s fine'\n---\nb", map[string]string{"description": "it's fine"}, "b"},
		{"folded", "---\nname: a\ndescription: >\n  one line\n  continued\n---\nb", map[string]string{"name": "a", "description": "one line continued"}, "b"},
		{"literal", "---\ndescription: |\n  first\n  second\n---\nb", map[string]string{"description": "first\nsecond"}, "b"},
		{"nested settings are ignored", "---\nname: a\nmetadata:\n  author: me\n  version: 2\ndescription: d\n---\nb", map[string]string{"name": "a", "metadata": "author: me version: 2", "description": "d"}, "b"},
		{"colon in a plain value", "---\ndescription: Use when: forms\n---\nb", map[string]string{"description": "Use when: forms"}, "b"},
		{"crlf and bom", "\uFEFF---\r\nname: a\r\ndescription: d\r\n---\r\nb", map[string]string{"name": "a", "description": "d"}, "b"},
		{"empty header", "---\n---\nbody", map[string]string{}, "body"},
		{"comments", "---\nname: a\n# explanation\ndescription: |+\n  first\n  second\n---   \nbody", map[string]string{"name": "a", "description": "first\nsecond"}, "body"},
		{"delimiter must be a line", "---\nname: a\n---not-a-delimiter\ndescription: d\n---\nbody", map[string]string{"name": "a", "description": "d"}, "body"},
		{"none", "# Title\n", map[string]string{}, "# Title\n"},
		{"unterminated", "---\nname: a\n", map[string]string{}, "---\nname: a\n"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			data, body := Parse(c.in)
			if len(data) != len(c.want) {
				t.Fatalf("data = %v, want %v", data, c.want)
			}
			for k, v := range c.want {
				if data[k] != v {
					t.Errorf("%s = %q, want %q", k, data[k], v)
				}
			}
			if body != c.body {
				t.Errorf("body = %q, want %q", body, c.body)
			}
		})
	}
}
