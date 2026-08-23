/// Anthropic VLM API Client
///
/// Handles all communication with the Anthropic Messages API.
/// Used for per-death classification (tier-2) and coaching report generation (tier-3).
use thiserror::Error;

#[derive(Debug, Error)]
pub enum VlmError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("API error {status}: {body}")]
    ApiError { status: u16, body: String },
    #[error("Parse error: {0}")]
    ParseError(String),
}

/// Result of classifying a single death moment.
#[derive(Debug)]
pub struct ClassificationResult {
    /// One of: crosshair, positioning, utility, decision, outplayed
    pub category_id: String,
    /// 0.0–1.0 confidence
    pub confidence: f64,
    /// One-sentence explanation
    pub brief_reason: String,
}

pub struct AnthropicClient {
    api_key: String,
    http: reqwest::Client,
}

impl AnthropicClient {
    pub fn new(api_key: String) -> Self {
        Self {
            api_key,
            http: reqwest::Client::new(),
        }
    }

    /// Internal: POST to the Anthropic messages endpoint and return the text content.
    async fn call(
        &self,
        model: &str,
        messages: serde_json::Value,
        max_tokens: u32,
    ) -> Result<String, VlmError> {
        let resp = self
            .http
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&serde_json::json!({
                "model": model,
                "max_tokens": max_tokens,
                "messages": messages,
            }))
            .send()
            .await?;

        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(VlmError::ApiError { status, body });
        }

        let body: serde_json::Value = resp.json().await?;
        let text = body["content"][0]["text"]
            .as_str()
            .ok_or_else(|| VlmError::ParseError("No text in API response".into()))?
            .to_string();

        Ok(text)
    }

    /// Classify a death moment. Optionally includes a JPEG frame as base64.
    /// Uses claude-haiku for cost efficiency (≈$0.001 per classification).
    pub async fn classify_death(
        &self,
        prompt: &str,
        frame_b64: Option<&str>,
    ) -> Result<ClassificationResult, VlmError> {
        let mut content = Vec::new();

        // Add frame image if available
        if let Some(b64) = frame_b64 {
            content.push(serde_json::json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": b64
                }
            }));
        }

        content.push(serde_json::json!({
            "type": "text",
            "text": prompt
        }));

        let messages = serde_json::json!([{ "role": "user", "content": content }]);
        let text = self
            .call("claude-haiku-4-5-20251001", messages, 512)
            .await?;

        // Parse JSON from response — the prompt asks for JSON, but Claude may wrap it
        let json = extract_json(&text)
            .ok_or_else(|| VlmError::ParseError(format!("No JSON in: {text}")))?;

        let category_id = json
            .get("cause")
            .or_else(|| json.get("categoryId"))
            .and_then(|v| v.as_str())
            .unwrap_or("outplayed")
            .to_string();

        let confidence = json
            .get("confidence")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.75);

        let brief_reason = json
            .get("brief_reason")
            .or_else(|| json.get("briefReason"))
            .and_then(|v| v.as_str())
            .unwrap_or("Classification completed")
            .to_string();

        Ok(ClassificationResult {
            category_id,
            confidence,
            brief_reason,
        })
    }

    /// Generate a full coaching report from match context.
    /// Returns the raw parsed JSON (frontend maps it to CoachingReport type).
    pub async fn generate_coaching_report(
        &self,
        prompt: &str,
    ) -> Result<serde_json::Value, VlmError> {
        let messages = serde_json::json!([{ "role": "user", "content": prompt }]);
        let text = self
            .call("claude-haiku-4-5-20251001", messages, 4096)
            .await?;

        extract_json(&text)
            .ok_or_else(|| VlmError::ParseError(format!("No JSON in coaching response: {text}")))
    }
}

/// Extract the first complete JSON object from a text string.
/// Claude sometimes wraps JSON in markdown code blocks or adds prose around it.
fn extract_json(text: &str) -> Option<serde_json::Value> {
    // Try the whole string first
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(text.trim()) {
        return Some(v);
    }

    // Find first { and last } and try to parse that range
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end > start {
        serde_json::from_str(&text[start..=end]).ok()
    } else {
        None
    }
}
