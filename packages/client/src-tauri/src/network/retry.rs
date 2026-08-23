/// Offline retry processor.
///
/// Periodically checks the `pending_uploads` table and retries failed API calls
/// with exponential backoff (1s, 2s, 4s, … up to 64s).
///
/// Max 10 retries per item before marking `failed_permanent`.
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use crate::storage::PendingUploadRow;
use crate::AppState;

/// Payload stored as JSON for a full-game analysis retry.
#[derive(serde::Deserialize)]
struct FullGamePayload {
    context_json: String,
    video_path: String,
}

static RETRY_NOTIFY: once_cell::sync::Lazy<Arc<Notify>> =
    once_cell::sync::Lazy::new(|| Arc::new(Notify::new()));

/// Wake the retry loop immediately (e.g. after queuing a new upload).
pub fn wake_retry_loop() {
    RETRY_NOTIFY.notify_one();
}

/// Start the background retry loop. Should be called once on app startup.
pub fn spawn_retry_loop(app_handle: AppHandle) {
    let notify = RETRY_NOTIFY.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            // Wait for either a wake signal or a 30-second timeout
            tokio::select! {
                _ = notify.notified() => {},
                _ = tokio::time::sleep(Duration::from_secs(30)) => {},
            }

            if let Err(e) = process_pending(&app_handle).await {
                log::warn!("Retry processor error: {e}");
            }
        }
    });
}

async fn process_pending(app_handle: &AppHandle) -> Result<(), String> {
    let rows = {
        let state = app_handle.state::<AppState>();
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_retriable_uploads().map_err(|e| e.to_string())?
    };

    if rows.is_empty() {
        return Ok(());
    }

    log::info!("Retry processor: {} pending uploads to retry", rows.len());

    // Quick connectivity check — try to reach the server (reuse API client's HTTP instance)
    let client = app_handle.state::<AppState>().api_client();
    let base_url = app_handle.state::<AppState>().server_url();
    let health_ok = client
        .http
        .get(format!("{}/api/v1/health", base_url))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);

    if !health_ok {
        log::info!("Retry processor: server unreachable, skipping cycle");
        return Ok(());
    }

    for row in rows {
        let result = match row.job_type.as_str() {
            "full_game" => retry_full_game(&client, &row).await,
            // Legacy entries from before the migration — skip gracefully
            "tier2" | "tier3" => {
                log::info!("Skipping legacy {} pending upload {}", row.job_type, row.id);
                let state = app_handle.state::<AppState>();
                let db = state.db.lock().map_err(|e| e.to_string())?;
                db.delete_pending_upload(&row.id)
                    .map_err(|e| e.to_string())?;
                continue;
            }
            _ => {
                log::warn!("Unknown pending upload type: {}", row.job_type);
                Err("unknown job type".into())
            }
        };

        let state = app_handle.state::<AppState>();
        let db = state.db.lock().map_err(|e| e.to_string())?;

        match result {
            Ok(()) => {
                log::info!("Retry succeeded for {} (match {})", row.id, row.match_id);
                db.delete_pending_upload(&row.id)
                    .map_err(|e| e.to_string())?;
                let _ = db.update_analysis_status(&row.match_id, "processing");

                // Emit event so the frontend knows to re-check
                let _ = app_handle.emit(
                    "scrima:retry-succeeded",
                    serde_json::json!({
                        "matchId": row.match_id,
                        "jobType": row.job_type,
                    }),
                );
            }
            Err(e) => {
                log::warn!(
                    "Retry failed for {} (attempt {}): {e}",
                    row.id,
                    row.retry_count + 1
                );
                db.update_pending_upload_retry(&row.id, Some(&e))
                    .map_err(|e2| e2.to_string())?;
            }
        }
    }

    Ok(())
}

async fn retry_full_game(
    client: &crate::network::api_client::ApiClient,
    row: &PendingUploadRow,
) -> Result<(), String> {
    let payload: FullGamePayload =
        serde_json::from_str(&row.payload_json).map_err(|e| e.to_string())?;

    let path = std::path::Path::new(&payload.video_path);
    if !path.exists() {
        return Err("Video file no longer exists".into());
    }

    client
        .upload_game_analysis(&row.match_id, path, payload.context_json)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}
