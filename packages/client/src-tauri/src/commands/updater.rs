/// Auto-updater commands
///
/// Exposes update checking to the React frontend.
/// Uses tauri-plugin-updater under the hood.
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub version: Option<String>,
    pub body: Option<String>,
}

/// Check for updates and return info without installing.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let updater = app
        .updater_builder()
        .build()
        .map_err(|e| format!("Updater init failed: {e}"))?;

    let response = updater.check().await;
    match response {
        Ok(Some(update)) => Ok(UpdateInfo {
            available: true,
            version: Some(update.version.clone()),
            body: update.body.clone(),
        }),
        Ok(None) => Ok(UpdateInfo {
            available: false,
            version: None,
            body: None,
        }),
        Err(e) => {
            log::warn!("Update check failed: {e}");
            Ok(UpdateInfo {
                available: false,
                version: None,
                body: None,
            })
        }
    }
}

/// Download and install an available update, then restart.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app
        .updater_builder()
        .build()
        .map_err(|e| format!("Updater init failed: {e}"))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("Update check failed: {e}"))?
        .ok_or_else(|| "No update available".to_string())?;

    log::info!("Downloading update v{}...", update.version);

    update
        .download_and_install(|_chunk_len, _content_len| {}, || {})
        .await
        .map_err(|e| format!("Update install failed: {e}"))?;

    log::info!("Update installed — restarting");
    app.restart();
}
