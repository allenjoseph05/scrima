/// Tauri IPC Commands — Detection (STUBBED)
///
/// Game detection has been removed from the client. These stubs remain
/// because the Tauri command registry still references them. They return
/// safe defaults so the frontend doesn't break.
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DetectionStatusResponse {
    pub is_detecting: bool,
    pub game_id: Option<String>,
}

#[tauri::command]
pub async fn get_detection_status() -> Result<DetectionStatusResponse, String> {
    Ok(DetectionStatusResponse {
        is_detecting: false,
        game_id: None,
    })
}

#[tauri::command]
pub async fn get_events() -> Result<Vec<serde_json::Value>, String> {
    Ok(vec![])
}

#[tauri::command]
pub async fn get_match_summary() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "matchId": null,
        "gameId": "valorant",
        "startedAtMs": 0,
        "endedAtMs": 0,
        "durationMs": 0,
        "kills": 0,
        "deaths": 0,
        "assists": 0,
        "rounds": [],
        "events": [],
        "metrics": [],
        "coachableMoments": []
    }))
}

#[tauri::command]
pub async fn clear_events() -> Result<(), String> {
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct SupportedGame {
    pub id: String,
    pub name: String,
}

#[tauri::command]
pub async fn get_supported_games() -> Result<Vec<SupportedGame>, String> {
    Ok(vec![SupportedGame {
        id: "valorant".to_string(),
        name: "Valorant".to_string(),
    }])
}
