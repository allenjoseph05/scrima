/// Tauri IPC command handlers
///
/// Submodules expose recording, detection, and other backend capabilities
/// to the React frontend via Tauri's invoke mechanism.
pub mod analysis;
pub mod auth;
pub mod detection;
pub mod recording;
pub mod settings;
pub mod subscription;
pub mod updater;

/// Greeting command — kept for smoke-testing the IPC bridge.
#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! Welcome to Scrima.", name)
}

/// Returns the current application version from Cargo.toml.
#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
