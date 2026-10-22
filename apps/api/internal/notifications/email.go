package notifications

import (
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	htmltpl "html/template"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"strconv"
	"strings"
	texttpl "text/template"
	"time"

	"github.com/pr0h0/finance-platform/apps/api/internal/config"
)

// Email templates are fixed strings parsed once; notification text is only ever passed as data
// (html/template escapes it), so user-controlled titles cannot inject template syntax or markup.
var (
	textMail = texttpl.Must(texttpl.New("t").Parse("{{.Title}}\n\n{{.Body}}\n\n{{.Open}}: {{.Link}}\n\n-- \n{{.Footer}}\n"))
	htmlMail = htmltpl.Must(htmltpl.New("h").Parse(`<!doctype html><html lang="{{.Lang}}"><body style="font-family:system-ui,sans-serif;color:#111;max-width:560px">
<h2 style="font-size:18px">{{.Title}}</h2>
<p style="white-space:pre-line">{{.Body}}</p>
<p><a href="{{.Link}}">{{.Open}}</a></p>
<hr style="border:0;border-top:1px solid #ddd"><p style="font-size:12px;color:#666">{{.Footer}}</p>
</body></html>`))
)

var mailStrings = map[string][2]string{ // open link, footer
	"en": {"Open notifications", "You receive this because email notifications are on. Change it in Settings → Notifications."},
	"bs": {"Otvori obavještenja", "Ovu poruku primate jer su obavještenja e-poštom uključena. Promijenite to u Postavke → Obavještenja."},
}

type mailData struct{ Lang, Title, Body, Link, Open, Footer string }

// headerSafe drops CR/LF and other control characters so values cannot add header lines.
func headerSafe(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s)
}

// buildMail renders a multipart/alternative (plain text + HTML) message in the user's locale (en|bs).
func buildMail(from, to *mail.Address, locale, title, body, link string, now time.Time) ([]byte, error) {
	if _, ok := mailStrings[locale]; !ok {
		locale = "en"
	}
	s := mailStrings[locale]
	d := mailData{Lang: locale, Title: title, Body: body, Link: link, Open: s[0], Footer: s[1]}
	var txt, html bytes.Buffer
	if err := textMail.Execute(&txt, d); err != nil {
		return nil, err
	}
	if err := htmlMail.Execute(&html, d); err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	id := make([]byte, 12)
	_, _ = rand.Read(id)
	mw := multipart.NewWriter(&buf)
	domain := from.Address[strings.LastIndexByte(from.Address, '@')+1:]
	fmt.Fprintf(&buf, "From: %s\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nMessage-ID: <%s@%s>\r\nMIME-Version: 1.0\r\n"+
		"Auto-Submitted: auto-generated\r\nContent-Type: multipart/alternative; boundary=%s\r\n\r\n",
		from.String(), to.String(), mime.QEncoding.Encode("utf-8", headerSafe(title)), now.Format(time.RFC1123Z),
		hex.EncodeToString(id), headerSafe(domain), mw.Boundary())
	for _, p := range []struct {
		ct   string
		body []byte
	}{{"text/plain; charset=utf-8", txt.Bytes()}, {"text/html; charset=utf-8", html.Bytes()}} {
		w, err := mw.CreatePart(textproto.MIMEHeader{"Content-Type": {p.ct}, "Content-Transfer-Encoding": {"quoted-printable"}})
		if err != nil {
			return nil, err
		}
		qp := quotedprintable.NewWriter(w)
		if _, err := qp.Write(p.body); err != nil {
			return nil, err
		}
		if err := qp.Close(); err != nil {
			return nil, err
		}
	}
	if err := mw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// smtpTLS is the TLS config for SMTP connections (tests swap it to trust a self-signed server).
var smtpTLS = func(host string) *tls.Config { return &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12} }

func emailConfigured(cfg *config.Config) bool {
	return cfg != nil && cfg.SMTPHost != "" && cfg.SMTPFrom != ""
}

// sendMail delivers one message over SMTP: implicit TLS ("tls"), STARTTLS required ("starttls") or
// plaintext ("none", only for a local relay; net/smtp refuses PLAIN auth without TLS off localhost).
func sendMail(cfg *config.Config, to string, locale, title, body string) error {
	if !emailConfigured(cfg) {
		return errors.New("SMTP is not configured")
	}
	from, err := mail.ParseAddress(cfg.SMTPFrom)
	if err != nil {
		return fmt.Errorf("SMTP_FROM: %w", err)
	}
	rcpt, err := mail.ParseAddress(to)
	if err != nil {
		return fmt.Errorf("recipient: %w", err)
	}
	msg, err := buildMail(from, rcpt, locale, title, body, cfg.PublicURL+"/notifications", time.Now())
	if err != nil {
		return err
	}
	addr := net.JoinHostPort(cfg.SMTPHost, strconv.Itoa(cfg.SMTPPort))
	d := &net.Dialer{Timeout: 15 * time.Second}
	var conn net.Conn
	if cfg.SMTPTLS == "tls" {
		conn, err = tls.DialWithDialer(d, "tcp", addr, smtpTLS(cfg.SMTPHost))
	} else {
		conn, err = d.Dial("tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("smtp connect: %w", err)
	}
	_ = conn.SetDeadline(time.Now().Add(60 * time.Second))
	c, err := smtp.NewClient(conn, cfg.SMTPHost)
	if err != nil {
		conn.Close()
		return fmt.Errorf("smtp: %w", err)
	}
	defer c.Close()
	if cfg.SMTPTLS == "starttls" {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return errors.New("smtp: server does not offer STARTTLS (set SMTP_TLS=none only for a local relay)")
		}
		if err := c.StartTLS(smtpTLS(cfg.SMTPHost)); err != nil {
			return fmt.Errorf("smtp starttls: %w", err)
		}
	}
	if cfg.SMTPUser != "" {
		if err := c.Auth(smtp.PlainAuth("", cfg.SMTPUser, cfg.SMTPPassword, cfg.SMTPHost)); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}
	if err := c.Mail(from.Address); err != nil {
		return fmt.Errorf("smtp MAIL: %w", err)
	}
	if err := c.Rcpt(rcpt.Address); err != nil {
		return fmt.Errorf("smtp RCPT: %w", err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("smtp DATA: %w", err)
	}
	if _, err := w.Write(msg); err != nil {
		return fmt.Errorf("smtp DATA: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp DATA: %w", err)
	}
	return c.Quit()
}
