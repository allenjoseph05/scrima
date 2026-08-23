/// User-facing error classification for Tauri events that reach the UI.
///
/// The raw anyhow::Error message can leak file paths, internal types, or
/// server stack traces. We keep that verbose text in the log::error! call
/// and emit only a coarse `error_code` + short `user_message` to JS.
use std::fmt::Display;

#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UserFacingError {
    /// Server couldn't be reached over HTTP (timeout, DNS, refused, offline).
    Network,
    /// A long-running operation exceeded its deadline.
    Timeout,
    /// Server explicitly rejected the request (4xx/5xx payload).
    ServerRejected,
    /// ffmpeg couldn't run or exited non-zero.
    Ffmpeg,
    /// VLM / Gemini pipeline failed during analysis.
    Analysis,
    /// Something else we can't classify.
    Internal,
}

impl UserFacingError {
    /// Short, user-safe copy for the UI. Never mentions tool names, paths,
    /// or internal identifiers.
    pub fn user_message(self) -> &'static str {
        match self {
            UserFacingError::Network => {
                "Can't reach Scrima's servers. Check your connection and try again."
            }
            UserFacingError::Timeout => "That took too long. Please try again.",
            UserFacingError::ServerRejected => {
                "The server rejected this request. Try again in a moment."
            }
            UserFacingError::Ffmpeg => "Couldn't process the recording. Please try again.",
            UserFacingError::Analysis => "Analysis failed. Please try again.",
            UserFacingError::Internal => "Something went wrong. Please try again.",
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            UserFacingError::Network => "network",
            UserFacingError::Timeout => "timeout",
            UserFacingError::ServerRejected => "server_rejected",
            UserFacingError::Ffmpeg => "ffmpeg",
            UserFacingError::Analysis => "analysis",
            UserFacingError::Internal => "internal",
        }
    }

    /// Classify an arbitrary error by substring-matching its Display impl.
    /// Intentionally simple — we don't need precision, just safe fallback copy.
    pub fn classify<E: Display>(err: &E) -> Self {
        let s = err.to_string().to_lowercase();

        if s.contains("timed out") || s.contains("timeout") || s.contains("deadline") {
            return UserFacingError::Timeout;
        }
        if s.contains("connect")
            || s.contains("dns")
            || s.contains("refused")
            || s.contains("unreachable")
            || s.contains("network")
            || s.contains("offline")
            || s.contains("no such host")
        {
            return UserFacingError::Network;
        }
        if s.contains("ffmpeg") || s.contains("decode") || s.contains("encoding") {
            return UserFacingError::Ffmpeg;
        }
        if s.contains("vlm")
            || s.contains("gemini")
            || s.contains("enrichment")
            || s.contains("analysis")
        {
            return UserFacingError::Analysis;
        }
        if s.contains("4") && (s.contains("status") || s.contains("http")) {
            return UserFacingError::ServerRejected;
        }
        UserFacingError::Internal
    }
}
