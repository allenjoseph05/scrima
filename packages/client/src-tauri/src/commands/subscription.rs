/// Subscription commands — manage billing, credits, and plan upgrades.
///
/// Checkout and portal sessions open Stripe's hosted pages in the system browser.
/// The server handles all Stripe webhook events and updates the user's tier.
use tauri::State;

use crate::AppState;

/// Fetch the user's profile including subscription tier.
#[tauri::command]
pub async fn get_user_profile(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let client = state.api_client();
    client.get_user_profile().await.map_err(|e| e.to_string())
}

/// Create a Stripe checkout session and return the URL.
/// The frontend opens this URL in the system browser.
#[tauri::command]
pub async fn create_checkout_session(
    state: State<'_, AppState>,
    tier: String,
) -> Result<String, String> {
    let client = state.api_client();
    let server_url = state.server_url();
    // After payment, Stripe redirects to these URLs (back to our server with a success/cancel page)
    let success_url = format!("{}/api/v1/auth/device?payment=success", server_url);
    let cancel_url = format!("{}/api/v1/auth/device?payment=cancelled", server_url);

    client
        .create_checkout_session(&tier, &success_url, &cancel_url)
        .await
        .map_err(|e| e.to_string())
}

/// Create a Stripe billing portal session and return the URL.
/// The frontend opens this URL in the system browser to manage subscription.
#[tauri::command]
pub async fn create_portal_session(state: State<'_, AppState>) -> Result<String, String> {
    let client = state.api_client();
    let server_url = state.server_url();
    let return_url = format!("{}/api/v1/auth/device?portal=done", server_url);

    client
        .create_portal_session(&return_url)
        .await
        .map_err(|e| e.to_string())
}
