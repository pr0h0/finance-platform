// OS credential store for the server bearer token (PLAN: secure app storage): macOS/iOS Keychain,
// Windows Credential Manager, Linux Secret Service (GNOME Keyring, KWallet). Android has no backend
// in the keyring crate: the commands fail there and the web app keeps the token in app storage (as it
// also does when a Linux session has no Secret Service).
#[cfg(not(target_os = "android"))]
mod imp {
    // Debug builds use their own item, so tests and dev runs never touch the installed app's token.
    #[cfg(not(debug_assertions))]
    const SERVICE: &str = "me.pr0h0.finplat";
    #[cfg(debug_assertions)]
    const SERVICE: &str = "me.pr0h0.finplat.debug";
    fn entry(key: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())
    }
    pub fn get(key: &str) -> Result<Option<String>, String> {
        match entry(key)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    pub fn set(key: &str, value: &str) -> Result<(), String> {
        entry(key)?.set_password(value).map_err(|e| e.to_string())
    }
    pub fn delete(key: &str) -> Result<(), String> {
        match entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(target_os = "android")]
mod imp {
    const NO: &str = "no OS credential store on Android";
    pub fn get(_: &str) -> Result<Option<String>, String> {
        Err(NO.into())
    }
    pub fn set(_: &str, _: &str) -> Result<(), String> {
        Err(NO.into())
    }
    pub fn delete(_: &str) -> Result<(), String> {
        Err(NO.into())
    }
}

/// None = no such secret; an error = no usable credential store on this system.
#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    imp::get(&key)
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    imp::set(&key, &value)
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    imp::delete(&key)
}
