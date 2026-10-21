package mcp

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/jsonschema-go/jsonschema"

	"github.com/pr0h0/finance-platform/apps/api/internal/authz"
	"github.com/pr0h0/finance-platform/apps/api/internal/changes"
	"github.com/pr0h0/finance-platform/apps/api/internal/httpx"
)

// tools.json is generated from packages/mcp-contracts (gen/tools.ts): names, descriptions, scopes
// and input JSON Schemas are shared with the future local (desktop) MCP server.
//
//go:embed tools.json
var toolsJSON []byte

type toolDef struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Annotations struct {
		ReadOnlyHint bool `json:"readOnlyHint"`
	} `json:"annotations"`
	InputSchema json.RawMessage `json:"inputSchema"`
	Scopes      []string        `json:"scopes"`
	resolved    *jsonschema.Resolved
}

var catalogue = loadCatalogue()

func loadCatalogue() []*toolDef {
	var defs []*toolDef
	if err := json.Unmarshal(toolsJSON, &defs); err != nil {
		panic("mcp: tools.json: " + err.Error())
	}
	for _, d := range defs {
		var s jsonschema.Schema
		if err := json.Unmarshal(d.InputSchema, &s); err != nil {
			panic("mcp: schema of " + d.Name + ": " + err.Error())
		}
		r, err := s.Resolve(nil)
		if err != nil {
			panic("mcp: resolve schema of " + d.Name + ": " + err.Error())
		}
		d.resolved = r
	}
	return defs
}

func findTool(name string) *toolDef {
	for _, d := range catalogue {
		if d.Name == name {
			return d
		}
	}
	return nil
}

// Result size limit (PLAN §28): agents get aggregates and pages, never a whole database.
const maxResultBytes = 512 << 10

// decodeArgs validates arguments against the shared JSON Schema, applies its defaults and decodes
// into the typed input, rejecting unknown fields.
func decodeArgs(def *toolDef, raw json.RawMessage, into any) error {
	if len(bytes.TrimSpace(raw)) == 0 || string(raw) == "null" {
		raw = json.RawMessage(`{}`)
	}
	var inst map[string]any
	if err := json.Unmarshal(raw, &inst); err != nil {
		return httpx.BadRequest("arguments must be a JSON object")
	}
	if err := def.resolved.ApplyDefaults(&inst); err != nil {
		return httpx.BadRequest(err.Error())
	}
	if err := def.resolved.Validate(inst); err != nil {
		return httpx.Validation(map[string]string{"arguments": err.Error()})
	}
	b, _ := json.Marshal(inst)
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		return httpx.Validation(map[string]string{"arguments": err.Error()})
	}
	return nil
}

type readFn func(ctx context.Context, s *session, def *toolDef, args json.RawMessage) (any, error)

// call runs one tool, enforcing the result size limit and auditing every call (PLAN §142).
func (s *session) call(ctx context.Context, name string, args json.RawMessage) (any, error) {
	start := time.Now()
	ctx = authz.WithPrincipal(ctx, s.principal)
	s.lastProfile = nil
	res, err := s.dispatch(ctx, name, args)
	size := 0
	if err == nil {
		b, merr := json.Marshal(res)
		if merr != nil {
			err = merr
		} else if size = len(b); size > maxResultBytes {
			res, err = nil, httpx.NewError(http.StatusUnprocessableEntity, "result_too_large",
				fmt.Sprintf("result is %d KiB (limit %d KiB); narrow the filters or lower limit", size>>10, maxResultBytes>>10))
		}
	}
	md := map[string]any{"tool": name, "ok": err == nil, "duration_ms": time.Since(start).Milliseconds(), "result_bytes": size}
	if len(args) <= 4096 {
		md["arguments"] = json.RawMessage(args)
	} else {
		md["arguments_truncated"] = true
	}
	var he *httpx.Error
	if errors.As(err, &he) {
		md["error_code"] = he.Code
	} else if err != nil {
		md["error_code"] = "internal"
	}
	_ = changes.Audit(ctx, s.db, changes.Entry{ProfileID: s.lastProfile, Action: "mcp.tool_call", EntityType: "mcp_clients", EntityID: &s.clientID, Metadata: md})
	return res, err
}

func (s *session) dispatch(ctx context.Context, name string, args json.RawMessage) (any, error) {
	def := findTool(name)
	if def == nil {
		return nil, httpx.NewError(http.StatusNotFound, "unknown_tool", "no such tool: "+name)
	}
	switch name {
	case "preview_changes":
		return s.previewChanges(ctx, def, args)
	case "apply_approved_changes":
		return s.applyApproved(ctx, def, args)
	}
	if fn, ok := readTools[name]; ok {
		return fn(ctx, s, def, args)
	}
	if fn, ok := writeTools[name]; ok {
		return s.write(ctx, def, fn, args)
	}
	return nil, httpx.NewError(http.StatusNotImplemented, "not_implemented", "tool "+name+" has no server implementation")
}

// errorPayload is what an agent sees when a tool fails (isError result, never a protocol error,
// so the model can correct itself).
func errorPayload(err error) map[string]any {
	var he *httpx.Error
	switch {
	case errors.As(err, &he):
	case errors.Is(err, authz.ErrForbidden):
		he = toolErr("forbidden", "not allowed")
	case errors.Is(err, authz.ErrUnauthenticated):
		he = httpx.Unauthorized()
	default:
		he = httpx.NewError(http.StatusInternalServerError, "internal", "internal error")
	}
	e := map[string]any{"code": he.Code, "message": he.Message}
	if he.Details != nil {
		e["details"] = he.Details
	}
	return map[string]any{"error": e}
}
