// SQLite persistence for packages/storage's MemoryStore (StorePersistence). One database file per
// local store (local mode, or one cache per server) in the app data directory. Rows are opaque JSON
// produced by the web app (binary values are tagged base64); every commit is one SQLite
// transaction, so a crash never leaves half a write. Schema:
//   rows(tbl, k, json)  k = JSON of the row key (string or number), PRIMARY KEY (tbl, k)
//   meta(key, value)    'version' (local schema version), 'seq' (autoIncrement counters, JSON)
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct Stores(Mutex<HashMap<String, Connection>>);

#[derive(Deserialize)]
pub struct Change {
    table: String,
    key: serde_json::Value,
    /// Encoded row, or null when the row was deleted.
    row: Option<String>,
}

#[derive(Deserialize)]
pub struct Commit {
    version: i64,
    seq: serde_json::Value,
    changes: Vec<Change>,
}

fn db_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // store names look like "finplat-local" or "finplat@fin.example.org": keep a safe file name
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "@.-_".contains(c) { c } else { '_' })
        .collect();
    Ok(dir.join(format!("{safe}.sqlite3")))
}

fn with_db<T>(
    app: &AppHandle,
    stores: &State<Stores>,
    name: &str,
    f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
) -> Result<T, String> {
    let mut map = stores.0.lock().map_err(|_| "store lock poisoned".to_string())?;
    if !map.contains_key(name) {
        let c = Connection::open(db_path(app, name)?).map_err(|e| e.to_string())?;
        c.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS rows (tbl TEXT NOT NULL, k TEXT NOT NULL, json TEXT NOT NULL,
               PRIMARY KEY (tbl, k)) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .map_err(|e| e.to_string())?;
        map.insert(name.to_string(), c);
    }
    f(map.get_mut(name).expect("inserted above")).map_err(|e| e.to_string())
}

/// The whole store as {"version","seq","tables":{table:[row,...]}} (a JSON string the web app parses
/// with its binary reviver), or null for a store that was never written.
#[tauri::command]
pub fn store_load(app: AppHandle, stores: State<Stores>, name: String) -> Result<Option<String>, String> {
    with_db(&app, &stores, &name, |c| {
        let version: Option<String> = c
            .query_row("SELECT value FROM meta WHERE key = 'version'", [], |r| r.get(0))
            .optional()?;
        let Some(version) = version else { return Ok(None) };
        let seq: String = c
            .query_row("SELECT value FROM meta WHERE key = 'seq'", [], |r| r.get(0))
            .optional()?
            .unwrap_or_else(|| "{}".into());
        let mut tables: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut q = c.prepare("SELECT tbl, json FROM rows ORDER BY tbl")?;
        let mut rows = q.query([])?;
        while let Some(r) = rows.next()? {
            tables.entry(r.get(0)?).or_default().push(r.get(1)?);
        }
        let mut out = format!("{{\"version\":{version},\"seq\":{seq},\"tables\":{{");
        for (i, (t, rs)) in tables.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&serde_json::to_string(t).unwrap_or_default());
            out.push_str(":[");
            out.push_str(&rs.join(","));
            out.push(']');
        }
        out.push_str("}}");
        Ok(Some(out))
    })
}

/// Applies one write transaction of the web app atomically.
#[tauri::command]
pub fn store_commit(app: AppHandle, stores: State<Stores>, name: String, commit: Commit) -> Result<(), String> {
    with_db(&app, &stores, &name, |c| {
        let tx = c.transaction()?;
        {
            let mut put = tx.prepare_cached("INSERT OR REPLACE INTO rows (tbl, k, json) VALUES (?1, ?2, ?3)")?;
            let mut del = tx.prepare_cached("DELETE FROM rows WHERE tbl = ?1 AND k = ?2")?;
            for ch in &commit.changes {
                let k = ch.key.to_string();
                match &ch.row {
                    Some(json) => put.execute(params![ch.table, k, json])?,
                    None => del.execute(params![ch.table, k])?,
                };
            }
        }
        tx.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('version', ?1), ('seq', ?2)",
            params![commit.version.to_string(), commit.seq.to_string()],
        )?;
        tx.commit()
    })
}

/// Deletes the database file of a store (explicit user action: "delete local data").
#[tauri::command]
pub fn store_destroy(app: AppHandle, stores: State<Stores>, name: String) -> Result<(), String> {
    if let Ok(mut map) = stores.0.lock() {
        map.remove(&name); // closes the connection
    }
    let path = db_path(&app, &name)?;
    for suffix in ["", "-wal", "-shm"] {
        let p = PathBuf::from(format!("{}{suffix}", path.display()));
        if p.exists() {
            std::fs::remove_file(&p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
