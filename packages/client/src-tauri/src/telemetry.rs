/// Lightweight error telemetry for the desktop client.
///
/// Reports unhandled panics and critical errors to the server's
/// error endpoint when the user has opted in (privacy_consent setting).
///
/// This does NOT use the Sentry SDK — it sends a minimal JSON payload
/// to our own API which can forward to Sentry or any other service.
use std::sync::atomic::{AtomicBool, Ordering};

static TELEMETRY_ENABLED: AtomicBool = AtomicBool::new(false);

/// Enable telemetry reporting (call after checking user consent).
pub fn enable_telemetry() {
    TELEMETRY_ENABLED.store(true, Ordering::Relaxed);
}

/// Report a critical error to the server. Fire-and-forget.
pub fn report_error(error: &str, context: &str) {
    if !TELEMETRY_ENABLED.load(Ordering::Relaxed) {
        return;
    }

    let error = error.to_string();
    let context = context.to_string();
    let version = env!("CARGO_PKG_VERSION").to_string();

    // Use try_current to avoid panic if not on a tokio runtime
    // (e.g. when called from the panic hook on a non-tokio thread)
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(async move {
            let payload = serde_json::json!({
                "error": error,
                "context": context,
                "client_version": version,
                "platform": std::env::consts::OS,
            });

            // Best-effort — don't block or retry
            let _ = reqwest::Client::new()
                .post("https://api.scrima.gg/api/v1/telemetry/error")
                .json(&payload)
                .timeout(std::time::Duration::from_secs(5))
                .send()
                .await;
        });
    }
    // If no runtime available, silently skip telemetry
}

/// Install a panic hook that reports panics before aborting.
pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic".to_string()
        };

        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_default();

        log::error!("PANIC at {location}: {msg}");
        report_error(&msg, &format!("panic at {location}"));

        default_hook(info);
    }));
}
