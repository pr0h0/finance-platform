// Package logging builds the slog logger with secret redaction.
package logging

import (
	"io"
	"log/slog"
	"regexp"
)

var sensitive = regexp.MustCompile(`(?i)(pass(word)?|secret|token|authorization|cookie|api[_-]?key|recovery|credential|private[_-]?key|session)`)

// Redact replaces values of sensitive-looking attribute keys. Never log raw financial
// attachments or full request bodies; log ids instead.
func Redact(_ []string, a slog.Attr) slog.Attr {
	if sensitive.MatchString(a.Key) && a.Value.Kind() != slog.KindGroup {
		return slog.String(a.Key, "[REDACTED]")
	}
	return a
}

func New(w io.Writer, level, format string) *slog.Logger {
	var lv slog.Level
	if err := lv.UnmarshalText([]byte(level)); err != nil {
		lv = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: lv, ReplaceAttr: Redact}
	if format == "text" {
		return slog.New(slog.NewTextHandler(w, opts))
	}
	return slog.New(slog.NewJSONHandler(w, opts))
}
