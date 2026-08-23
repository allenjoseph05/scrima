/// Scrima — Tauri application entry point
///
/// Wires together:
///   - AppState: shared mutable state for recording and storage
///   - Tauri command handlers: IPC bridge to the React frontend
pub mod analysis;
pub mod classification;
pub mod commands;
pub mod errors;
pub mod network;
pub mod recording;
pub mod storage;
pub mod telemetry;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;

use crate::recording::{RecordingConfig, RecordingManager};
use crate::storage::Database;

// ============================================================
// APP STATE
// ============================================================

/// Shared application state managed by Tauri.
/// All fields are `Mutex`- or `RwLock`-wrapped so they are Send + Sync.
pub struct AppState {
    /// FFMPEG recording manager — Mutex because start/stop mutate it
    pub recording: Mutex<RecordingManager>,
    /// SQLite database — Mutex because rusqlite Connection is not Sync
    pub db: Mutex<Database>,
    /// Timestamp (ms) of the last HUD sighting.
    /// Read by analysis pipeline.
    pub last_hud_seen_ms: AtomicI64,
    /// Currently active game ID (defaults to "valorant")
    pub active_game_id: Mutex<Option<String>>,
    /// Cancel token for the active analysis pipeline; None when idle
    pub analysis_cancel: Mutex<Option<Arc<AtomicBool>>>,
}

/// Production server URL. Overridden by env var or SQLite setting.
const DEFAULT_SERVER_URL: &str = "https://api.scrima.gg";

impl AppState {
    fn new(db_path: &std::path::Path) -> Result<Self, String> {
        let rec = RecordingManager::new(RecordingConfig::default());
        let db = Database::open(db_path).map_err(|e| e.to_string())?;
        Ok(Self {
            recording: Mutex::new(rec),
            db: Mutex::new(db),
            last_hud_seen_ms: AtomicI64::new(0),
            active_game_id: Mutex::new(None),
            analysis_cancel: Mutex::new(None),
        })
    }

    /// Resolve the server API URL. Priority:
    ///   1. `SCRIMA_API_URL` env var (dev override)
    ///   2. `server_url` key in SQLite settings table
    ///   3. Production default (`https://api.scrima.gg`)
    pub fn server_url(&self) -> String {
        // Env var takes top priority (development / CI)
        if let Ok(url) = std::env::var("SCRIMA_API_URL") {
            if !url.trim().is_empty() {
                return url;
            }
        }

        // SQLite setting (user-configured via settings UI)
        if let Ok(db) = self.db.lock() {
            if let Some(url) = db.get_setting("server_url").ok().flatten() {
                if !url.trim().is_empty() {
                    return url;
                }
            }
        }

        DEFAULT_SERVER_URL.to_string()
    }

    /// Get the stored auth token (session token from device auth flow).
    pub fn auth_token(&self) -> Option<String> {
        if let Ok(db) = self.db.lock() {
            db.get_setting("auth_token")
                .ok()
                .flatten()
                .filter(|s| !s.trim().is_empty())
        } else {
            None
        }
    }

    /// Create an authenticated API client using the stored server URL and auth token.
    pub fn api_client(&self) -> crate::network::api_client::ApiClient {
        let url = self.server_url();
        match self.auth_token() {
            Some(token) => crate::network::api_client::ApiClient::with_auth(url, token),
            None => crate::network::api_client::ApiClient::new(url),
        }
    }
}

// Game detection removed — server handles all analysis from video.
// Recording is controlled manually by the user.

// ============================================================
// HELPERS
// ============================================================

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Resolve the ffmpeg binary path — local install takes priority over PATH.
pub fn ffmpeg_bin() -> String {
    let local = app_data_dir().join("bin").join("ffmpeg.exe");
    if local.exists() {
        local.to_string_lossy().to_string()
    } else {
        "ffmpeg".to_string()
    }
}

/// Platform-appropriate app data directory.
pub fn app_data_dir() -> PathBuf {
    // Try the dirs crate first (respects platform conventions)
    if let Some(data_dir) = dirs::data_local_dir() {
        return data_dir.join("Scrima");
    }

    // Fallback for Windows without dirs
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_else(|_| "C:\\temp".into());
        return PathBuf::from(appdata).join("Scrima");
    }

    #[cfg(not(target_os = "windows"))]
    PathBuf::from("/tmp/scrima")
}

// ============================================================
// TAURI ENTRY POINT
// ============================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialise env_logger — RUST_LOG=info or RUST_LOG=scrima=debug
    let _ = env_logger::Builder::from_default_env()
        .filter_level(log::LevelFilter::Info)
        .try_init();

    // Install panic hook for error telemetry
    crate::telemetry::install_panic_hook();

    tauri::Builder::default()
        // Block webview navigation to external URLs.
        // Without this, when the Vite dev server is down or network drops,
        // WebView2 shows its built-in "can't reach this page" error that
        // looks like Microsoft Edge — confusing users.
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("navigation-guard")
                .on_navigation(|_webview, url: &tauri::Url| {
                    let allowed = url.scheme() == "tauri"
                        || url.scheme() == "asset"
                        || url.host_str() == Some("tauri.localhost")
                        || url.host_str() == Some("localhost")
                        || url.host_str() == Some("127.0.0.1");
                    if !allowed {
                        log::warn!("Blocked webview navigation to external URL: {url}");
                    }
                    allowed
                })
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Ensure app data directory exists
            let data_dir = app_data_dir();
            let _ = std::fs::create_dir_all(&data_dir);

            // Open database
            let db_path = data_dir.join("scrima.db");
            let state = AppState::new(&db_path).map_err(|e| {
                log::error!("AppState init failed: {e}");
                tauri::Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e))
            })?;

            // Clean up stale matches (missing/corrupt recordings) before managing state
            if let Ok(db) = state.db.lock() {
                match db.cleanup_stale_matches() {
                    Ok(0) => {}
                    Ok(n) => log::info!("Cleaned up {n} stale match(es)"),
                    Err(e) => log::warn!("Stale match cleanup: {e}"),
                }
            }

            app.manage(state);

            // Enable error telemetry if user has given consent
            {
                let state_ref = app.state::<AppState>();
                let has_consent = state_ref
                    .db
                    .lock()
                    .ok()
                    .and_then(|db| db.get_setting("privacy_consent").ok().flatten())
                    .is_some();
                if has_consent {
                    crate::telemetry::enable_telemetry();
                }
            }

            // Crash recovery: kill orphan ffmpeg, clean up incomplete recordings
            crate::recording::cleanup_orphan_ffmpeg();

            // Start offline retry processor
            crate::network::retry::spawn_retry_loop(app.handle().clone());

            // Open devtools automatically in debug builds
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }

            log::info!("Scrima initialised — ready for manual recording");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Basic
            commands::greet,
            commands::get_app_version,
            // Recording
            commands::recording::start_recording,
            commands::recording::stop_recording,
            commands::recording::get_recording_status,
            commands::recording::check_ffmpeg,
            commands::recording::install_ffmpeg,
            commands::recording::list_recent_matches,
            commands::recording::count_recent_matches,
            commands::recording::open_clips_folder,
            commands::recording::open_recording,
            commands::recording::delete_match,
            commands::recording::update_match_metadata,
            // Detection
            commands::detection::get_detection_status,
            commands::detection::get_events,
            commands::detection::get_match_summary,
            commands::detection::clear_events,
            commands::detection::get_supported_games,
            // Analysis
            commands::analysis::run_analysis,
            commands::analysis::cancel_analysis,
            commands::analysis::run_trend_analysis,
            commands::analysis::get_trend_report,
            commands::analysis::get_deep_analysis_status,
            commands::analysis::get_deep_coaching_report,
            commands::analysis::refresh_deep_coaching_report,
            commands::analysis::get_coaching_credits,
            commands::analysis::check_server_health,
            commands::analysis::ask_match_question,
            commands::analysis::get_weekly_report_latest,
            commands::analysis::get_weekly_reports,
            commands::analysis::get_pending_upload_count,
            commands::analysis::import_video,
            commands::analysis::get_coaching_observations,
            commands::analysis::get_coaching_brain,
            commands::analysis::ask_brain_question,
            commands::analysis::get_brain_greeting,
            commands::analysis::dismiss_observation,
            commands::analysis::agree_observation,
            commands::analysis::disagree_observation,
            commands::analysis::reset_brain,
            commands::analysis::get_compass,
            commands::analysis::get_death_frame,
            commands::analysis::get_pre_session_briefing,
            commands::analysis::commit_focus,
            commands::analysis::get_eras,
            commands::analysis::get_hypotheses,
            commands::analysis::confirm_hypothesis,
            commands::analysis::reject_hypothesis,
            commands::analysis::get_coach_messages,
            commands::analysis::mark_coach_message_read,
            // Settings
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::get_all_settings,
            // Auth
            commands::auth::auth_start_login,
            commands::auth::auth_poll_token,
            commands::auth::auth_get_status,
            commands::auth::auth_logout,
            // Subscription
            commands::subscription::get_user_profile,
            commands::subscription::create_checkout_session,
            commands::subscription::create_portal_session,
            // Updater
            commands::updater::check_for_update,
            commands::updater::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
