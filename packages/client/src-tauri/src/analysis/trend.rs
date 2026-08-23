/// Multi-Match Trend Analysis
///
/// Placeholder — trend analysis will be rebuilt to use full-game coaching reports
/// instead of the removed death classification data.
use thiserror::Error;

#[derive(Debug, Error)]
pub enum TrendError {
    #[error("Database: {0}")]
    Database(String),
    #[error("VLM: {0}")]
    Vlm(String),
    #[error("Trend analysis is being rebuilt — use full-game coaching reports for now")]
    InsufficientData,
}

impl From<crate::storage::StorageError> for TrendError {
    fn from(e: crate::storage::StorageError) -> Self {
        Self::Database(e.to_string())
    }
}

/// Trend analysis is currently disabled — will be rebuilt to aggregate
/// full-game coaching reports instead of death classifications.
pub async fn run_trend_pipeline(
    _n_matches: usize,
    _app_handle: tauri::AppHandle,
) -> Result<(), TrendError> {
    Err(TrendError::InsufficientData)
}
