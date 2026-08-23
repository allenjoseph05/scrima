use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
/// Frame Classification — Client-Side ONNX
///
/// Classifies game state from video frames using MobileNetV2.
/// Runs locally after recording to detect deaths and build a game timeline.
/// Replaces server-side classification for the new frame-based pipeline.
use std::path::Path;

const CLASSES: &[&str] = &[
    "gameplay",
    "death_screen",
    "spectating",
    "buy_phase",
    "round_end",
    "loading",
];
const IMAGE_SIZE: usize = 224;
const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];

/// Minimum consecutive death_screen frames (at 1 fps) to confirm a death.
/// 2 frames (~2s) is the sweet spot: real deaths show the death screen for
/// at least 2–3 seconds, while single-frame hallucinations don't persist.
const DEATH_CONFIRM_FRAMES: usize = 2;
/// Minimum gap between deaths in seconds.
/// 30s: a competitive Valorant round cannot resolve faster than ~30s (buy
/// phase alone is 30s), so two REAL deaths of the same player cannot be
/// closer than that. Anything marked as a death within 30s of the previous
/// one is spectating-a-teammate-die mistaken for self-death. Set by user.
/// NOTE: deathmatch allows deaths every ~5s — will need per-game-mode value.
const DEATH_COOLDOWN_SEC: f64 = 30.0;
/// Minimum classifier confidence for a `death_screen` prediction to count
/// toward a death. Below this, the frame is treated as "unsure" — does NOT
/// advance the streak AND does NOT reset it. 0.50 is permissive enough to
/// catch real deaths where the classifier is only moderately confident.
/// Was 0.75, which cut detections from ~22 to ~1 on a 14-death match.
const MIN_DEATH_CONFIDENCE: f32 = 0.50;

#[derive(Debug, Clone)]
pub struct FrameClassification {
    pub timestamp_sec: f64,
    pub class: String,
    pub confidence: f32,
}

#[derive(Debug, Clone)]
pub struct DetectedDeath {
    pub timestamp_sec: f64,
    pub frame_index: usize,
    /// Softmax confidence of the `death_screen` classification at the trigger
    /// frame. Uploaded to the server so we can prioritize high-confidence
    /// detections when >10 deaths are uploaded.
    pub confidence: f32,
}

pub struct FrameClassifier {
    session: Session,
}

impl FrameClassifier {
    /// Load the classifier model. Returns None if model file doesn't exist.
    pub fn load(app_data_dir: &Path) -> Option<Self> {
        let model_path = app_data_dir.join("models").join("valorant-classifier.onnx");
        if !model_path.exists() {
            log::warn!(
                "Classifier model not found at {:?} — frame classification unavailable",
                model_path
            );
            return None;
        }

        let result = (|| -> ort::Result<Session> {
            let mut builder = Session::builder()?;
            builder = builder.with_optimization_level(GraphOptimizationLevel::Level3)?;
            builder = builder.with_intra_threads(2)?;
            builder.commit_from_file(&model_path)
        })();

        match result {
            Ok(session) => {
                log::info!("Classifier model loaded from {:?}", model_path);
                Some(Self { session })
            }
            Err(e) => {
                log::error!("Failed to load classifier model: {e}");
                None
            }
        }
    }

    /// Classify a single raw RGB frame (224*224*3 bytes, RGB order).
    /// Returns (class_name, confidence).
    pub fn classify_rgb(&mut self, rgb_data: &[u8]) -> Result<(String, f32), String> {
        let expected = IMAGE_SIZE * IMAGE_SIZE * 3;
        if rgb_data.len() != expected {
            return Err(format!(
                "Expected {} bytes, got {}",
                expected,
                rgb_data.len()
            ));
        }

        // Normalize: convert u8 RGB to float32 NCHW with ImageNet stats
        let pixel_count = IMAGE_SIZE * IMAGE_SIZE;
        let mut input = vec![0f32; 3 * pixel_count];
        for i in 0..pixel_count {
            for c in 0..3 {
                let pixel = rgb_data[i * 3 + c] as f32 / 255.0;
                input[c * pixel_count + i] = (pixel - IMAGENET_MEAN[c]) / IMAGENET_STD[c];
            }
        }

        // Create input tensor [1, 3, 224, 224]
        let shape = [1usize, 3, IMAGE_SIZE, IMAGE_SIZE];
        let input_array = ndarray::Array4::<f32>::from_shape_vec(shape, input)
            .map_err(|e| format!("Tensor shape error: {e}"))?;

        let input_tensor =
            Tensor::from_array(input_array).map_err(|e| format!("Tensor creation error: {e}"))?;

        // Run inference
        let outputs = self
            .session
            .run(ort::inputs![input_tensor])
            .map_err(|e| format!("Inference error: {e}"))?;

        // Extract output logits — SessionOutputs doesn't have is_empty,
        // index directly (will panic if empty, but model always returns output)
        let output_value = &outputs[0];
        let (shape_vec, data) = output_value
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("Output extraction error: {e}"))?;

        // Collect logits — shape is typically [1, 6]
        let num_classes = if shape_vec.len() >= 2 {
            shape_vec[shape_vec.len() - 1] as usize
        } else {
            data.len()
        };
        let logits: Vec<f32> = data.iter().take(num_classes).copied().collect();
        let probs = softmax(&logits);

        let (max_idx, &max_prob) = probs
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
            .unwrap_or((0, &0.0));

        let class = CLASSES.get(max_idx).unwrap_or(&"unknown").to_string();
        Ok((class, max_prob))
    }

    /// Classify all frames and detect death timestamps.
    /// `frame_data` is a slice of raw RGB24 frames (each 224*224*3 bytes).
    /// `fps` is frames per second (e.g., 2.0 for 2fps extraction).
    /// Classify all frames and detect death timestamps.
    /// `progress_cb` is called every 100 frames with (current, total).
    pub fn classify_and_detect_deaths(
        &mut self,
        frame_data: &[Vec<u8>],
        fps: f64,
    ) -> (Vec<FrameClassification>, Vec<DetectedDeath>) {
        self.classify_and_detect_deaths_with_progress(frame_data, fps, |_, _| {})
    }

    pub fn classify_and_detect_deaths_with_progress(
        &mut self,
        frame_data: &[Vec<u8>],
        fps: f64,
        progress_cb: impl Fn(usize, usize),
    ) -> (Vec<FrameClassification>, Vec<DetectedDeath>) {
        let mut classifications = Vec::with_capacity(frame_data.len());
        let mut deaths = Vec::new();
        let mut death_streak = 0usize;
        let mut last_death_sec: f64 = -100.0;
        let total = frame_data.len();
        let mut last_class = String::new();
        let mut last_confidence: f32 = 0.0;
        let mut skipped = 0usize;

        for (i, frame) in frame_data.iter().enumerate() {
            let timestamp_sec = i as f64 / fps;

            if i % 100 == 0 {
                progress_cb(i, total);
                if i % 500 == 0 {
                    log::info!(
                        "Classifying frame {i}/{total} ({:.0}%), skipped {skipped} similar",
                        i as f64 / total as f64 * 100.0
                    );
                }
            }

            // Scene-change detection: skip ONNX if frame is very similar to previous.
            // Compare by sampling every 64th byte — fast (~2000 comparisons for 150KB frame).
            //
            // Force a real re-classification every 5th frame regardless of similarity.
            // Without this, a single wrong classification (e.g. a still gameplay frame
            // mis-labeled as death_screen) can propagate across a scene because each
            // subsequent near-identical frame just reuses the prior (wrong) label.
            // At 2 fps the forced re-check is every 2.5 seconds — cheap, robust.
            let force_reclassify = i > 0 && i % 5 == 0;
            let (class, confidence) =
                if i > 0 && !force_reclassify && frames_similar(&frame_data[i - 1], frame) {
                    skipped += 1;
                    (last_class.clone(), last_confidence)
                } else {
                    match self.classify_rgb(frame) {
                        Ok(r) => r,
                        Err(e) => {
                            log::warn!("Classification failed for frame {i}: {e}");
                            ("unknown".to_string(), 0.0)
                        }
                    }
                };

            last_class = class.clone();
            last_confidence = confidence;

            // Death detection: look for consecutive high-confidence death_screen frames.
            // A low-confidence death_screen guess (e.g. from an ambiguous
            // spectating frame with a red vignette) does NOT advance the streak —
            // treated as "unsure" so it neither counts nor resets the streak.
            if class == "death_screen" && confidence >= MIN_DEATH_CONFIDENCE {
                death_streak += 1;
                if death_streak == DEATH_CONFIRM_FRAMES {
                    let death_sec = (i - DEATH_CONFIRM_FRAMES + 1) as f64 / fps;
                    if death_sec - last_death_sec >= DEATH_COOLDOWN_SEC {
                        deaths.push(DetectedDeath {
                            timestamp_sec: death_sec,
                            frame_index: i - DEATH_CONFIRM_FRAMES + 1,
                            // The detection's confidence is the softmax prob at
                            // the trigger frame. Real deaths will typically show
                            // a second death_screen frame right after, so this
                            // is a solid single-number proxy for detection quality.
                            confidence,
                        });
                        last_death_sec = death_sec;
                    }
                }
            } else if class != "death_screen" {
                death_streak = 0;
            }
            // else: low-confidence death_screen — leave streak unchanged

            classifications.push(FrameClassification {
                timestamp_sec,
                class,
                confidence,
            });
        }

        let classified = frame_data.len() - skipped;
        log::info!(
            "Classified {} frames ({} ONNX inferences, {} skipped as similar): detected {} deaths",
            frame_data.len(),
            classified,
            skipped,
            deaths.len()
        );
        (classifications, deaths)
    }
}

/// Fast frame similarity check — samples every 64th byte and computes mean absolute difference.
/// Returns true if frames are visually similar enough to reuse the previous classification.
fn frames_similar(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    let step = 64;
    let mut diff_sum: u64 = 0;
    let mut samples: u64 = 0;
    let mut i = 0;
    while i < a.len() {
        diff_sum += (a[i] as i32 - b[i] as i32).unsigned_abs() as u64;
        samples += 1;
        i += step;
    }
    if samples == 0 {
        return false;
    }
    // Mean absolute difference per sampled byte. Threshold ~8 out of 255.
    // Gameplay frames typically differ by 2-5. Scene transitions differ by 30+.
    let mean_diff = diff_sum / samples;
    mean_diff < 8
}

fn softmax(logits: &[f32]) -> Vec<f32> {
    if logits.is_empty() {
        return Vec::new();
    }
    let max = logits.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let exps: Vec<f32> = logits.iter().map(|&x| (x - max).exp()).collect();
    let sum: f32 = exps.iter().sum();
    if sum == 0.0 {
        return vec![0.0; logits.len()];
    }
    exps.iter().map(|&x| x / sum).collect()
}
