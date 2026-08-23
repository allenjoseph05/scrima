/// Scrima API Client
///
/// Uploads game recordings to the Scrima server for Gemini analysis.
/// The server holds the Gemini API key — the client never needs one.
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum NetworkError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("Server error {status}: {body}")]
    Server { status: u16, body: String },
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Parse error: {0}")]
    Parse(String),
}

/// Response from POST /api/v1/coaching/deep-analyze (HTTP 202)
#[derive(Debug, serde::Deserialize)]
pub struct DeepAnalysisJobResponse {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "reportId")]
    pub report_id: String,
    pub status: String,
}

/// Response from GET /api/v1/coaching/jobs/:jobId
#[derive(Debug, serde::Deserialize)]
pub struct DeepAnalysisJobStatus {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "reportId")]
    pub report_id: Option<String>,
    pub status: String, // "queued" | "processing" | "completed" | "failed"
    pub error: Option<String>,
}

/// Progress info from frame analysis status endpoint
#[derive(Debug, serde::Deserialize)]
pub struct AnalysisJobProgress {
    pub current: Option<u32>,
    pub total: Option<u32>,
    pub succeeded: Option<u32>,
    pub failed: Option<u32>,
    pub stage: Option<String>,
}

/// Response from GET /api/v1/coaching/analyze-frames/:jobId/status
#[derive(Debug, serde::Deserialize)]
pub struct FrameAnalysisJobStatus {
    pub status: String,
    #[serde(rename = "reportId")]
    pub report_id: Option<String>,
    pub error: Option<String>,
    pub progress: Option<AnalysisJobProgress>,
}

/// Response from GET /api/v1/coaching/credits
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct CoachingCreditsResponse {
    pub total: i64,
    pub used: i64,
    pub remaining: i64,
    #[serde(rename = "resetsAt")]
    pub resets_at: String,
    pub month: String,
}

pub struct ApiClient {
    pub(crate) http: reqwest::Client,
    base_url: String,
    auth_token: Option<String>,
}

fn build_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .unwrap_or_else(|e| {
            eprintln!("Failed to build HTTP client with custom config: {e}, using default");
            reqwest::Client::new()
        })
}

impl ApiClient {
    pub fn new(base_url: String) -> Self {
        Self {
            http: build_http_client(),
            base_url,
            auth_token: None,
        }
    }

    pub fn with_auth(base_url: String, token: String) -> Self {
        Self {
            http: build_http_client(),
            base_url,
            auth_token: Some(token),
        }
    }

    /// Apply auth + version headers to a request builder.
    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let req = req.header("X-Client-Version", env!("CARGO_PKG_VERSION"));
        if let Some(ref token) = self.auth_token {
            req.header("Authorization", format!("Bearer {}", token))
        } else {
            req
        }
    }

    /// Cheap heartbeat used by the client connectivity monitor.
    /// Returns true iff GET /api/v1/health returns 2xx. A generous timeout
    /// is applied — a heartbeat that takes a moment to respond should NOT
    /// be confused with "the server is down," which is what a short timeout
    /// would do on cold or slow connections.
    pub async fn health_check(&self) -> bool {
        let url = format!("{}/api/v1/health", self.base_url.trim_end_matches('/'));
        match self
            .http
            .get(&url)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
        {
            Ok(resp) => resp.status().is_success(),
            Err(_) => false,
        }
    }

    /// Upload a 1fps analysis copy of a full game for Gemini coaching.
    ///
    /// The analysis copy is small (~10–20 MB for a 40-min game) since it's
    /// pre-compressed to 1fps 720p. This replaces the old per-clip upload.
    ///
    /// Returns a job ID immediately — the server queues Gemini Batch analysis.
    pub async fn upload_game_analysis(
        &self,
        match_id: &str,
        video_path: &std::path::Path,
        metadata_json: String,
    ) -> Result<DeepAnalysisJobResponse, NetworkError> {
        use reqwest::multipart;

        let bytes = std::fs::read(video_path)?;
        let file_size = bytes.len();
        log::info!(
            "Uploading analysis copy: {:.1} MB",
            file_size as f64 / 1_048_576.0
        );

        let part = multipart::Part::bytes(bytes)
            .file_name(format!("{match_id}.mp4"))
            .mime_str("video/mp4")
            .map_err(|e| NetworkError::Parse(e.to_string()))?;

        let form = multipart::Form::new()
            .text("context", metadata_json)
            .part("video", part);

        let url = format!("{}/api/v1/coaching/deep-analyze", self.base_url);
        let resp = self
            .auth(self.http.post(&url))
            .timeout(std::time::Duration::from_secs(600))
            .multipart(form)
            .send()
            .await?;

        let status = resp.status().as_u16();
        if status != 202 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }

        Ok(resp.json::<DeepAnalysisJobResponse>().await?)
    }

    /// Poll the deep coaching job status.
    pub async fn poll_deep_analysis_job(
        &self,
        job_id: &str,
    ) -> Result<DeepAnalysisJobStatus, NetworkError> {
        let url = format!("{}/api/v1/coaching/jobs/{}", self.base_url, job_id);
        let resp = self.auth(self.http.get(&url)).send().await?;

        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }

        Ok(resp.json::<DeepAnalysisJobStatus>().await?)
    }

    /// Fetch a completed coaching report by ID.
    pub async fn get_coaching_report_remote(
        &self,
        report_id: &str,
    ) -> Result<serde_json::Value, NetworkError> {
        let url = format!("{}/api/v1/coaching/reports/{}", self.base_url, report_id);
        let resp = self.auth(self.http.get(&url)).send().await?;

        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }

        Ok(resp.json::<serde_json::Value>().await?)
    }

    /// Fetch the user's coaching credit balance.
    pub async fn get_coaching_credits(&self) -> Result<CoachingCreditsResponse, NetworkError> {
        let url = format!("{}/api/v1/coaching/credits", self.base_url);
        let resp = self.auth(self.http.get(&url)).send().await?;

        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }

        Ok(resp.json::<CoachingCreditsResponse>().await?)
    }

    /// Fetch user profile including subscription tier and limits.
    pub async fn get_user_profile(&self) -> Result<serde_json::Value, NetworkError> {
        let url = format!("{}/api/v1/user/profile", self.base_url);
        let resp = self.auth(self.http.get(&url)).send().await?;

        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }

        Ok(resp.json::<serde_json::Value>().await?)
    }

    /// Create a Stripe checkout session for upgrading subscription.
    pub async fn create_checkout_session(
        &self,
        tier: &str,
        success_url: &str,
        cancel_url: &str,
    ) -> Result<String, NetworkError> {
        let url = format!("{}/api/v1/subscription/create-checkout", self.base_url);
        let resp = self
            .auth(self.http.post(&url))
            .json(&serde_json::json!({
                "tier": tier,
                "successUrl": success_url,
                "cancelUrl": cancel_url,
            }))
            .send()
            .await?;

        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }

        let body: serde_json::Value = resp.json().await?;
        body["url"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| NetworkError::Parse("Missing checkout URL".into()))
    }

    /// Create a Stripe billing portal session for managing subscription.
    pub async fn create_portal_session(&self, return_url: &str) -> Result<String, NetworkError> {
        let url = format!("{}/api/v1/subscription/portal", self.base_url);
        let resp = self
            .auth(self.http.post(&url))
            .json(&serde_json::json!({ "returnUrl": return_url }))
            .send()
            .await?;

        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }

        let body: serde_json::Value = resp.json().await?;
        body["url"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| NetworkError::Parse("Missing portal URL".into()))
    }

    /// Fetch the latest weekly coaching report.
    pub async fn get_weekly_report_latest(
        &self,
    ) -> Result<Option<serde_json::Value>, NetworkError> {
        let url = format!("{}/api/v1/coaching/weekly-reports/latest", self.base_url);
        let resp = self.auth(self.http.get(&url)).send().await?;

        let status = resp.status().as_u16();
        if status == 404 {
            return Ok(None);
        }
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }

        Ok(Some(resp.json::<serde_json::Value>().await?))
    }

    /// Fetch all weekly coaching reports.
    pub async fn get_weekly_reports(&self) -> Result<Vec<serde_json::Value>, NetworkError> {
        let url = format!("{}/api/v1/coaching/weekly-reports", self.base_url);
        let resp = self.auth(self.http.get(&url)).send().await?;

        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }

        Ok(resp.json::<Vec<serde_json::Value>>().await?)
    }

    /// Fetch player coaching observations for the "Your Coach" page.
    pub async fn get_coaching_observations(&self) -> Result<serde_json::Value, NetworkError> {
        let url = format!("{}/api/v1/coaching/observations", self.base_url);
        let resp = self.auth(self.http.get(&url)).send().await?;

        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }

        Ok(resp.json::<serde_json::Value>().await?)
    }

    /// Fetch full coaching brain state (mastery, graph, strategies, observations, reflections).
    pub async fn get_coaching_brain(&self) -> Result<serde_json::Value, NetworkError> {
        let url = format!("{}/api/v1/coaching/brain", self.base_url);
        let resp = self.auth(self.http.get(&url)).send().await?;

        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }

        Ok(resp.json::<serde_json::Value>().await?)
    }

    /// Upload extracted frames for analysis (new frame-based pipeline).
    ///
    /// Sends a JSON payload containing base64-encoded JPEG frames around each death,
    /// plus game metadata. Returns a job response for polling.
    pub async fn upload_analysis_frames(
        &self,
        match_id: &str,
        payload: String,
    ) -> Result<DeepAnalysisJobResponse, NetworkError> {
        let url = format!("{}/api/v1/coaching/analyze-frames", self.base_url);

        let resp = self
            .auth(self.http.post(&url))
            .timeout(Duration::from_secs(120))
            .header("Content-Type", "application/json")
            .body(payload)
            .send()
            .await?;

        let status = resp.status().as_u16();

        if status == 402 {
            return Err(NetworkError::Server {
                status: 402,
                body: "No coaching credits remaining".to_string(),
            });
        }

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }

        log::info!("Frame upload accepted for match {match_id} (HTTP {status})");
        Ok(resp.json::<DeepAnalysisJobResponse>().await?)
    }

    /// Poll frame analysis job status.
    pub async fn poll_frame_analysis_status(
        &self,
        job_id: &str,
    ) -> Result<FrameAnalysisJobStatus, NetworkError> {
        let url = format!(
            "{}/api/v1/coaching/analyze-frames/{}/status",
            self.base_url, job_id
        );
        let resp = self.auth(self.http.get(&url)).send().await?;
        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }
        Ok(resp.json::<FrameAnalysisJobStatus>().await?)
    }

    /// Upload high-fps enrichment frames for a coaching report.
    ///
    /// Sends base64-encoded JPEG frames extracted from the original 60fps recording.
    /// The server runs enrichment and updates the report in-place.
    pub async fn upload_enrichment_frames(
        &self,
        report_id: &str,
        frames: &[crate::analysis::clips::EnrichmentFrame],
    ) -> Result<EnrichmentResponse, NetworkError> {
        let url = format!(
            "{}/api/v1/coaching/reports/{}/enrich",
            self.base_url, report_id
        );

        let body = serde_json::json!({
            "frames": frames.iter().map(|f| serde_json::json!({
                "label": f.label,
                "base64": f.base64,
                "timestampSec": f.timestamp_sec,
            })).collect::<Vec<_>>(),
        });

        let resp = self
            .auth(self.http.post(&url))
            .timeout(Duration::from_secs(120))
            .json(&body)
            .send()
            .await?;

        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }

        Ok(resp.json::<EnrichmentResponse>().await?)
    }

    /// Chat with the coach using full brain context (not report-specific).
    pub async fn brain_chat(
        &self,
        question: &str,
        history: &[serde_json::Value],
    ) -> Result<BrainChatResponse, NetworkError> {
        let url = format!("{}/api/v1/coaching/brain-chat", self.base_url);
        let resp = self
            .auth(self.http.post(&url))
            .json(&serde_json::json!({
                "question": question,
                "history": history,
            }))
            .send()
            .await?;

        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }

        Ok(resp.json::<BrainChatResponse>().await?)
    }

    /// Get a personalized coaching greeting.
    pub async fn get_brain_greeting(&self) -> Result<BrainGreetingResponse, NetworkError> {
        let url = format!("{}/api/v1/coaching/brain-chat/greeting", self.base_url);
        let resp = self.auth(self.http.get(&url)).send().await?;

        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }

        Ok(resp.json::<BrainGreetingResponse>().await?)
    }

    /// Player agrees with an observation (Phase 6 — Brain self-model).
    /// Server sets confidence=1.0 and confirmed_at; observation weighs heavily in future prompts.
    pub async fn agree_observation(&self, id: &str) -> Result<serde_json::Value, NetworkError> {
        let url = format!(
            "{}/api/v1/coaching/observations/{}/agree",
            self.base_url, id
        );
        let resp = self
            .auth(self.http.post(&url))
            .json(&serde_json::json!({}))
            .send()
            .await?;

        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }
        Ok(resp.json::<serde_json::Value>().await?)
    }

    /// Player disagrees with an observation (Phase 6).
    /// Server sets confidence=0.0 and disagreed_at; observation filtered out of future prompts.
    pub async fn disagree_observation(&self, id: &str) -> Result<serde_json::Value, NetworkError> {
        let url = format!(
            "{}/api/v1/coaching/observations/{}/disagree",
            self.base_url, id
        );
        let resp = self
            .auth(self.http.post(&url))
            .json(&serde_json::json!({}))
            .send()
            .await?;

        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }
        Ok(resp.json::<serde_json::Value>().await?)
    }

    /// Dismiss (archive) a single observation.
    pub async fn dismiss_observation(&self, id: &str) -> Result<serde_json::Value, NetworkError> {
        let url = format!(
            "{}/api/v1/coaching/observations/{}/dismiss",
            self.base_url, id
        );
        let resp = self
            .auth(self.http.post(&url))
            .json(&serde_json::json!({}))
            .send()
            .await?;

        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }

        Ok(resp.json::<serde_json::Value>().await?)
    }

    /// Fetch unread coach messages (Phase 7D — proactive coach).
    pub async fn get_coach_messages(&self) -> Result<serde_json::Value, NetworkError> {
        let url = format!("{}/api/v1/coaching/messages", self.base_url);
        let resp = self.auth(self.http.get(&url)).send().await?;
        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }
        Ok(resp.json::<serde_json::Value>().await?)
    }

    /// Mark a coach message read (Phase 7D).
    pub async fn mark_coach_message_read(
        &self,
        id: &str,
    ) -> Result<serde_json::Value, NetworkError> {
        let url = format!(
            "{}/api/v1/coaching/messages/{}/mark-read",
            self.base_url, id
        );
        let resp = self
            .auth(self.http.post(&url))
            .json(&serde_json::json!({}))
            .send()
            .await?;
        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }
        Ok(resp.json::<serde_json::Value>().await?)
    }

    /// Fetch the player's pending hypotheses (Phase 7B — still figuring out).
    pub async fn get_hypotheses(&self) -> Result<serde_json::Value, NetworkError> {
        let url = format!("{}/api/v1/coaching/hypotheses", self.base_url);
        let resp = self.auth(self.http.get(&url)).send().await?;
        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }
        Ok(resp.json::<serde_json::Value>().await?)
    }

    /// Player agrees with a hypothesis (Phase 7B).
    pub async fn confirm_hypothesis(&self, id: &str) -> Result<serde_json::Value, NetworkError> {
        let url = format!(
            "{}/api/v1/coaching/hypotheses/{}/confirm",
            self.base_url, id
        );
        let resp = self
            .auth(self.http.post(&url))
            .json(&serde_json::json!({}))
            .send()
            .await?;
        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }
        Ok(resp.json::<serde_json::Value>().await?)
    }

    /// Player disagrees with a hypothesis (Phase 7B).
    pub async fn reject_hypothesis(&self, id: &str) -> Result<serde_json::Value, NetworkError> {
        let url = format!("{}/api/v1/coaching/hypotheses/{}/reject", self.base_url, id);
        let resp = self
            .auth(self.http.post(&url))
            .json(&serde_json::json!({}))
            .send()
            .await?;
        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }
        Ok(resp.json::<serde_json::Value>().await?)
    }

    /// Fetch the player's eras (Phase 5 — Living Mind chapters).
    pub async fn get_eras(&self) -> Result<serde_json::Value, NetworkError> {
        let url = format!("{}/api/v1/coaching/eras", self.base_url);
        let resp = self.auth(self.http.get(&url)).send().await?;
        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }
        Ok(resp.json::<serde_json::Value>().await?)
    }

    /// Fetch the Dashboard pre-session briefing (Phase 4 — "Before you play" card).
    pub async fn get_pre_session_briefing(&self) -> Result<serde_json::Value, NetworkError> {
        let url = format!("{}/api/v1/coaching/pre-session-briefing", self.base_url);
        let resp = self.auth(self.http.get(&url)).send().await?;
        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }
        Ok(resp.json::<serde_json::Value>().await?)
    }

    /// Record a focus commitment for the current session (Phase 4).
    /// The latest commitment (within 24h) is injected into the next report's prompt.
    pub async fn commit_focus(&self, focus: &str) -> Result<serde_json::Value, NetworkError> {
        let url = format!("{}/api/v1/coaching/focus-commitment", self.base_url);
        let resp = self
            .auth(self.http.post(&url))
            .json(&serde_json::json!({ "focus": focus }))
            .send()
            .await?;

        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }
        Ok(resp.json::<serde_json::Value>().await?)
    }

    /// Fetch the player's bottleneck compass state (Phase 3).
    /// Optional priority_category lets the server compute alignment with the current report's issue.
    pub async fn get_compass(
        &self,
        priority_category: Option<&str>,
    ) -> Result<serde_json::Value, NetworkError> {
        let url = match priority_category {
            Some(cat) => format!(
                "{}/api/v1/coaching/compass?priorityCategory={}",
                self.base_url, cat
            ),
            None => format!("{}/api/v1/coaching/compass", self.base_url),
        };
        let resp = self.auth(self.http.get(&url)).send().await?;
        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }
        Ok(resp.json::<serde_json::Value>().await?)
    }

    /// Reset the player's entire coaching brain.
    pub async fn reset_brain(&self) -> Result<serde_json::Value, NetworkError> {
        let url = format!("{}/api/v1/coaching/brain/reset", self.base_url);
        let resp = self
            .auth(self.http.post(&url))
            .json(&serde_json::json!({}))
            .send()
            .await?;

        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }

        Ok(resp.json::<serde_json::Value>().await?)
    }

    /// Ask a question about a coaching report (Q&A chat).
    ///
    /// Sends the report context + question + conversation history to the server.
    /// The server uses the coaching report as context for an LLM response.
    pub async fn ask_match_question(
        &self,
        report_id: &str,
        question: &str,
        history: &[serde_json::Value],
    ) -> Result<MatchQnAResponse, NetworkError> {
        let url = format!("{}/api/v1/coaching/chat", self.base_url);
        let resp = self
            .auth(self.http.post(&url))
            .json(&serde_json::json!({
                "reportId": report_id,
                "question": question,
                "history": history,
            }))
            .send()
            .await?;

        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(NetworkError::Server { status, body });
        }

        Ok(resp.json::<MatchQnAResponse>().await?)
    }
}

/// Response from POST /api/v1/coaching/reports/:reportId/enrich
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct EnrichmentResponse {
    pub enriched: bool,
    #[serde(rename = "deathsUpdated", default)]
    pub deaths_updated: usize,
    #[serde(default)]
    pub already: bool,
    pub error: Option<String>,
}

/// Per-chat quota snapshot returned by the server after each billable question.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct ChatQuotaSnapshot {
    pub limit: i64,
    pub remaining: i64,
}

/// Response from POST /api/v1/coaching/chat
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct MatchQnAResponse {
    pub answer: String,
    #[serde(rename = "tokensUsed", default)]
    pub tokens_used: i64,
    /// True when the LLM refused on content-safety grounds. The client
    /// should render the `answer` as a muted deflection and not charge the
    /// user's quota.
    #[serde(rename = "softBlock", default)]
    pub soft_block: bool,
    #[serde(default)]
    pub quota: Option<ChatQuotaSnapshot>,
}

/// Response from POST /api/v1/coaching/brain-chat
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct BrainChatResponse {
    pub answer: String,
    #[serde(rename = "tokensUsed", default)]
    pub tokens_used: i64,
    #[serde(rename = "softBlock", default)]
    pub soft_block: bool,
    #[serde(default)]
    pub quota: Option<ChatQuotaSnapshot>,
}

/// Response from GET /api/v1/coaching/brain-chat/greeting
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct BrainGreetingResponse {
    pub greeting: String,
}
