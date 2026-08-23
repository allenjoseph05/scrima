use serde::{Deserialize, Serialize};
/// Auth commands — device code login flow
///
/// Flow:
///   1. Frontend calls `auth_start_login()` → gets { userCode, deviceCode, verifyUrl }
///   2. Frontend opens verifyUrl in system browser
///   3. Frontend polls `auth_poll_token(deviceCode)` every 3 seconds
///   4. When verified → returns session token + user info
///   5. Frontend calls `auth_save_session(token, ...)` → stored in SQLite
///   6. All API calls now include the auth token automatically
use tauri::State;

use crate::AppState;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeResponse {
    pub user_code: String,
    pub device_code: String,
    pub verify_url: String,
    pub expires_in: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub session_token: String,
    pub user_id: String,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub subscription_tier: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub is_logged_in: bool,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub subscription_tier: Option<String>,
}

/// Start the device auth flow — returns a user code and verify URL.
#[tauri::command]
pub async fn auth_start_login(state: State<'_, AppState>) -> Result<DeviceCodeResponse, String> {
    let server_url = state.server_url();
    let url = format!("{}/api/v1/auth/device-code", server_url);

    let http = reqwest::Client::new();
    let resp = http
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to server: {}", e))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Server error: {}", body));
    }

    resp.json::<DeviceCodeResponse>()
        .await
        .map_err(|e| format!("Invalid server response: {}", e))
}

/// Poll for auth completion. Returns Ok(Some(session)) when verified, Ok(None) when still pending.
#[tauri::command]
pub async fn auth_poll_token(
    state: State<'_, AppState>,
    device_code: String,
) -> Result<Option<AuthSession>, String> {
    let server_url = state.server_url();
    let url = format!("{}/api/v1/auth/device-token", server_url);

    let http = reqwest::Client::new();
    let resp = http
        .post(&url)
        .json(&serde_json::json!({ "deviceCode": device_code }))
        .send()
        .await
        .map_err(|e| format!("Poll failed: {}", e))?;

    let status = resp.status().as_u16();

    if status == 202 {
        // Still pending
        return Ok(None);
    }

    if status == 410 {
        return Err("Login code expired. Please try again.".into());
    }

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Server error: {}", body));
    }

    let session: AuthSession = resp
        .json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))?;

    // Auto-save the session
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let _ = db.set_setting("auth_token", &session.session_token);
        let _ = db.set_setting("auth_user_id", &session.user_id);
        if let Some(ref email) = session.email {
            let _ = db.set_setting("auth_email", email);
        }
        if let Some(ref name) = session.display_name {
            let _ = db.set_setting("auth_display_name", name);
        }
        if let Some(ref tier) = session.subscription_tier {
            let _ = db.set_setting("auth_subscription_tier", tier);
        }
    }

    Ok(Some(session))
}

/// Check if the user is currently logged in (has a stored session token).
#[tauri::command]
pub fn auth_get_status(state: State<'_, AppState>) -> Result<AuthStatus, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let token = db.get_setting("auth_token").ok().flatten();
    let is_logged_in = token
        .as_ref()
        .map(|t| !t.trim().is_empty())
        .unwrap_or(false);

    Ok(AuthStatus {
        is_logged_in,
        email: db.get_setting("auth_email").ok().flatten(),
        display_name: db.get_setting("auth_display_name").ok().flatten(),
        subscription_tier: db.get_setting("auth_subscription_tier").ok().flatten(),
    })
}

/// Log out — clear stored session.
#[tauri::command]
pub fn auth_logout(state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let _ = db.set_setting("auth_token", "");
    let _ = db.set_setting("auth_user_id", "");
    let _ = db.set_setting("auth_email", "");
    let _ = db.set_setting("auth_display_name", "");
    let _ = db.set_setting("auth_subscription_tier", "");
    Ok(())
}
