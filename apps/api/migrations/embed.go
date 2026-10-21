// Package migrations embeds the SQL migrations.
// Naming rule: YYYYMMDDHHMMSS_<module>_<description>.sql (UTC timestamp), goose annotations.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
