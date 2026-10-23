// Automatic backups to a folder (desktop; Settings → Backups & data). The user picks the folder in
// the OS dialog here, so the web app never gets a general file-system scope: backup_write only writes
// finplat-backup-*.finplat files (already encrypted by the web app) into that folder and keeps the
// newest KEEP of them. The folder is remembered in <app config>/backup-folder.
use tauri::{AppHandle, Manager, Runtime};

const KEEP: usize = 10;
const PREFIX: &str = "finplat-backup-";
const SUFFIX: &str = ".finplat";

fn config<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("backup-folder"))
}

fn folder<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    let p = std::fs::read_to_string(config(app).ok()?).ok()?;
    let p = std::path::PathBuf::from(p.trim());
    p.is_dir().then_some(p)
}

#[tauri::command]
pub fn backup_folder_get<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    folder(&app).map(|p| p.display().to_string())
}

/// Opens the OS folder picker; None when the user cancels.
#[tauri::command]
pub async fn backup_folder_pick<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_dialog::DialogExt;
        let Some(dir) = app.dialog().file().blocking_pick_folder() else {
            return Ok(None);
        };
        let dir = dir.into_path().map_err(|e| e.to_string())?;
        let cfg = config(&app)?;
        std::fs::create_dir_all(cfg.parent().ok_or("no config directory")?)
            .map_err(|e| e.to_string())?;
        std::fs::write(&cfg, dir.display().to_string()).map_err(|e| e.to_string())?;
        Ok(Some(dir.display().to_string()))
    }
    #[cfg(mobile)]
    {
        let _ = app;
        Err("automatic backups to a folder are desktop only".into())
    }
}

#[tauri::command]
pub fn backup_folder_clear<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let cfg = config(&app)?;
    if cfg.exists() {
        std::fs::remove_file(cfg).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Body: the encrypted backup bytes; header `x-name`: finplat-backup-<digits, T, ->.finplat.
#[tauri::command]
pub fn backup_write<R: Runtime>(
    app: AppHandle<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    let name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-name")?;
    if !valid_name(name) {
        return Err(format!("invalid backup file name {name:?}"));
    }
    let dir = folder(&app).ok_or("no backup folder chosen (or it no longer exists)")?;
    let tmp = dir.join(format!("{name}.part"));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(name)).map_err(|e| e.to_string())?;
    prune(&dir);
    Ok(dir.join(name).display().to_string())
}

fn valid_name(name: &str) -> bool {
    name.strip_prefix(PREFIX)
        .and_then(|s| s.strip_suffix(SUFFIX))
        .is_some_and(|mid| {
            !mid.is_empty()
                && mid
                    .chars()
                    .all(|c| c.is_ascii_digit() || c == '-' || c == 'T')
        })
}

/// Keeps the newest KEEP backups (names sort by date); never touches other files.
fn prune(dir: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = rd
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| valid_name(n))
        .collect();
    names.sort();
    let n = names.len().saturating_sub(KEEP);
    for old in &names[..n] {
        let _ = std::fs::remove_file(dir.join(old));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_pruning() {
        assert!(valid_name("finplat-backup-2026-10-23T1830.finplat"));
        assert!(!valid_name("finplat-backup-.finplat"));
        assert!(!valid_name("finplat-backup-../x.finplat"));
        assert!(!valid_name("other.finplat"));
        let dir = std::env::temp_dir().join(format!("finplat-prune-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for d in 10..=22 {
            std::fs::write(
                dir.join(format!("finplat-backup-2026-10-{d}.finplat")),
                b"x",
            )
            .unwrap();
        }
        std::fs::write(dir.join("notes.txt"), b"keep").unwrap();
        prune(&dir);
        let mut left: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        left.sort();
        assert_eq!(left.len(), KEEP + 1);
        assert!(dir.join("notes.txt").exists());
        assert!(!dir.join("finplat-backup-2026-10-12.finplat").exists());
        assert!(dir.join("finplat-backup-2026-10-13.finplat").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
