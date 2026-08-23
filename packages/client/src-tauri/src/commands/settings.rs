use crate::AppState;
/// Settings command handlers
///
/// Thin wrappers around the DB key-value settings table.
use tauri::State;

/// Read a single setting value by key. Returns None if not set.
#[tauri::command]
pub fn get_setting(key: String, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_setting(&key).map_err(|e| e.to_string())
}

/// Write a setting value. Overwrites if the key already exists.
#[tauri::command]
pub fn set_setting(key: String, value: String, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.set_setting(&key, &value).map_err(|e| e.to_string())
}

/// Read all settings as a flat key-value map.
#[tauri::command]
pub fn get_all_settings(
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_all_settings().map_err(|e| e.to_string())
}
