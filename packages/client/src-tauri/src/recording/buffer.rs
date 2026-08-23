/// Rolling Video Buffer Management
///
/// Keeps the last N games on disk. When the limit is reached,
/// the oldest recording is deleted to make room. This implements
/// the "~50 GB rolling buffer of 20 games" from the spec.
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// A recording file on disk with metadata.
#[derive(Debug, Clone)]
pub struct RecordingEntry {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub modified: SystemTime,
    pub match_id: String,
}

/// List all .mp4 recordings in a directory, sorted oldest-first.
pub fn list_recordings(dir: &Path) -> io::Result<Vec<RecordingEntry>> {
    let mut entries = Vec::new();

    if !dir.exists() {
        return Ok(entries);
    }

    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.extension().and_then(|e| e.to_str()) != Some("mp4") {
            continue;
        }

        // Skip analysis copies — they are managed alongside their primary recording
        if path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.ends_with("_analysis"))
            .unwrap_or(false)
        {
            continue;
        }

        let meta = std::fs::metadata(&path)?;
        let size = meta.len();
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let match_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();

        entries.push(RecordingEntry {
            path,
            size_bytes: size,
            modified,
            match_id,
        });
    }

    // Sort oldest first (earliest modified time first)
    entries.sort_by(|a, b| a.modified.cmp(&b.modified));
    Ok(entries)
}

/// Total disk usage of all recordings in the directory (bytes).
pub fn total_size(entries: &[RecordingEntry]) -> u64 {
    entries.iter().map(|e| e.size_bytes).sum()
}

/// Enforce rolling buffer policy:
/// - Keep at most `max_games` recordings
/// - Keep at most `max_bytes` total disk usage
/// - Deletes oldest files first until both constraints are satisfied.
///
/// Returns the number of files deleted.
pub fn enforce_rolling_buffer(dir: &Path, max_games: usize, max_bytes: u64) -> io::Result<usize> {
    let mut entries = list_recordings(dir)?;
    let mut deleted = 0;

    // Delete while over either limit
    while !entries.is_empty() && (entries.len() > max_games || total_size(&entries) > max_bytes) {
        let oldest = entries.remove(0); // Already sorted oldest-first
        log::info!(
            "Rolling buffer: deleting oldest recording {} ({:.1} MB)",
            oldest.match_id,
            oldest.size_bytes as f64 / 1_048_576.0
        );
        if let Err(e) = std::fs::remove_file(&oldest.path) {
            log::warn!("Failed to delete {}: {}", oldest.path.display(), e);
        } else {
            deleted += 1;
            // Also delete companion analysis copy if it exists
            let analysis_path = oldest
                .path
                .with_file_name(format!("{}_analysis.mp4", oldest.match_id));
            if analysis_path.exists() {
                let _ = std::fs::remove_file(&analysis_path);
                log::info!(
                    "Rolling buffer: also deleted analysis copy for {}",
                    oldest.match_id
                );
            }
        }
    }

    if deleted > 0 {
        log::info!("Rolling buffer: deleted {} old recordings", deleted);
    }

    Ok(deleted)
}

/// Get the total size of recordings in the directory, in bytes.
pub fn get_total_size_bytes(dir: &Path) -> io::Result<u64> {
    let entries = list_recordings(dir)?;
    Ok(total_size(&entries))
}

/// Count the number of recordings in the directory.
pub fn get_recording_count(dir: &Path) -> io::Result<usize> {
    let entries = list_recordings(dir)?;
    Ok(entries.len())
}

// ============================================================
// TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn setup_test_dir(test_name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("scrima_test_buffer_{test_name}"));
        let _ = fs::create_dir_all(&dir);
        // Clean up any leftover files
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(&dir);
        dir
    }

    fn write_fake_mp4(dir: &Path, name: &str, size_kb: u64) {
        let path = dir.join(format!("{}.mp4", name));
        let data = vec![0u8; (size_kb * 1024) as usize];
        fs::write(path, data).unwrap();
    }

    #[test]
    fn test_list_recordings_empty() {
        let dir = setup_test_dir("empty");
        let entries = list_recordings(&dir).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn test_rolling_buffer_deletes_oldest() {
        let dir = setup_test_dir("max_games");

        // Create 5 fake recordings
        for i in 0..5 {
            write_fake_mp4(&dir, &format!("match-{:04}", i), 10);
            // Small sleep to get different modification times
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        let entries = list_recordings(&dir).unwrap();
        assert_eq!(entries.len(), 5);

        // Enforce: keep max 3
        let deleted = enforce_rolling_buffer(&dir, 3, u64::MAX).unwrap();
        assert_eq!(deleted, 2);

        let remaining = list_recordings(&dir).unwrap();
        assert_eq!(remaining.len(), 3);
    }

    #[test]
    fn test_rolling_buffer_by_size() {
        let dir = setup_test_dir("max_bytes");

        // Create 3 recordings of 100 KB each = 300 KB total
        for i in 0..3 {
            write_fake_mp4(&dir, &format!("match-{:04}", i), 100);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        // Enforce max 200 KB → should delete 1 oldest
        let deleted = enforce_rolling_buffer(&dir, 100, 200 * 1024).unwrap();
        assert!(deleted >= 1);
    }
}
