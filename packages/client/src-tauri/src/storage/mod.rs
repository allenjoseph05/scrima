use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
/// Local SQLite Storage
///
/// Stores match metadata, event logs, death classifications, and app settings.
/// Uses rusqlite with the bundled feature (compiles SQLite from source, no dep required).
///
/// Schema from spec section 4.5. All timestamps are Unix milliseconds.
use std::path::Path;
use thiserror::Error;
use uuid::Uuid;

/// Game event struct — previously in games module, kept here for DB storage.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameEvent {
    pub id: Uuid,
    pub timestamp_ms: u64,
    pub event_type_id: String,
    pub confidence: f32,
    pub detection_sources: Vec<String>,
    pub data: serde_json::Value,
}

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("Database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Match not found: {0}")]
    NotFound(String),
}

// ============================================================
// ROW TYPES
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepAnalysisJobRow {
    pub id: String,
    pub match_id: String,
    pub server_job_id: Option<String>,
    pub server_report_id: Option<String>,
    /// uploading | polling | completed | failed
    pub status: String,
    pub error_msg: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepCoachingReportRow {
    pub id: String,
    pub match_id: String,
    pub server_report_id: String,
    pub report_json: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchRow {
    pub id: String,
    pub game_id: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub map: Option<String>,
    pub agent: Option<String>,
    pub game_mode: Option<String>,
    pub won: Option<bool>,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub recording_path: Option<String>,
    pub recording_size_bytes: Option<i64>,
    pub analysis_status: String,
    pub created_at: i64,
    /// 1-indexed rank across ALL matches by start time ascending — stable
    /// identifier the UI can show as "Game #N". Oldest = 1, newest = total.
    /// Consistent across every view (history, coaching) so the user sees the
    /// same number for the same physical match no matter which page they're on.
    #[serde(default)]
    pub match_number: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventRow {
    pub id: String,
    pub match_id: String,
    pub timestamp_ms: i64,
    pub event_type_id: String,
    pub confidence: f64,
    pub detection_sources: String, // JSON array
    pub data: String,              // JSON object
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingRow {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendReportRow {
    pub id: String,
    pub generated_at: i64,
    pub matches_analyzed: i64,
    pub report_json: String,
    pub top_patterns: String,
}

/// A queued upload that failed due to network issues.
/// Stored locally and retried with exponential backoff.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingUploadRow {
    pub id: String,
    pub match_id: String,
    /// "full_game"
    pub job_type: String,
    /// JSON payload with context + clip paths
    pub payload_json: String,
    pub retry_count: i64,
    pub last_attempt_at: i64,
    /// "pending" | "retrying" | "failed_permanent"
    pub status: String,
    pub error_msg: Option<String>,
    pub created_at: i64,
}

// ============================================================
// DATABASE
// ============================================================

pub struct Database {
    conn: Connection,
}

impl Database {
    /// Open (or create) the SQLite database at the given path.
    pub fn open(db_path: &Path) -> Result<Self, StorageError> {
        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let conn = Connection::open(db_path)?;

        // Performance pragmas
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
        ",
        )?;

        let db = Self { conn };
        db.initialize_schema()?;
        db.migrate_schema();
        Ok(db)
    }

    /// Create all tables if they don't exist.
    fn initialize_schema(&self) -> Result<(), StorageError> {
        self.conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS matches (
                id TEXT PRIMARY KEY,
                game_id TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                ended_at INTEGER,
                duration_ms INTEGER,
                map TEXT,
                agent TEXT,
                game_mode TEXT,
                won INTEGER,
                score_team INTEGER,
                score_enemy INTEGER,
                kills INTEGER DEFAULT 0,
                deaths INTEGER DEFAULT 0,
                assists INTEGER DEFAULT 0,
                recording_path TEXT,
                recording_size_bytes INTEGER,
                event_log_path TEXT,
                analysis_status TEXT DEFAULT 'none',
                created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
            );

            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                match_id TEXT NOT NULL REFERENCES matches(id),
                timestamp_ms INTEGER NOT NULL,
                event_type_id TEXT NOT NULL,
                confidence REAL NOT NULL,
                detection_sources TEXT NOT NULL,
                data TEXT NOT NULL DEFAULT '{}'
            );

            CREATE INDEX IF NOT EXISTS idx_events_match_ts
                ON events(match_id, timestamp_ms);

            CREATE TABLE IF NOT EXISTS coaching_reports (
                id TEXT PRIMARY KEY,
                match_id TEXT REFERENCES matches(id),
                type TEXT NOT NULL,
                generated_at INTEGER NOT NULL,
                games_analyzed INTEGER,
                report_json TEXT NOT NULL,
                top_patterns TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
            );

            CREATE TABLE IF NOT EXISTS trend_reports (
                id TEXT PRIMARY KEY,
                generated_at INTEGER NOT NULL,
                matches_analyzed INTEGER NOT NULL,
                report_json TEXT NOT NULL,
                top_patterns TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS deep_analysis_jobs (
                id TEXT PRIMARY KEY,
                match_id TEXT NOT NULL REFERENCES matches(id),
                server_job_id TEXT,
                server_report_id TEXT,
                status TEXT NOT NULL DEFAULT 'uploading',
                error_msg TEXT,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
                updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
            );

            CREATE INDEX IF NOT EXISTS idx_daj_match
                ON deep_analysis_jobs(match_id);

            CREATE TABLE IF NOT EXISTS deep_coaching_reports (
                id TEXT PRIMARY KEY,
                match_id TEXT NOT NULL REFERENCES matches(id),
                server_report_id TEXT NOT NULL,
                report_json TEXT NOT NULL,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
            );

            CREATE INDEX IF NOT EXISTS idx_dcr_match
                ON deep_coaching_reports(match_id);

            CREATE TABLE IF NOT EXISTS pending_uploads (
                id TEXT PRIMARY KEY,
                match_id TEXT NOT NULL,
                job_type TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                retry_count INTEGER NOT NULL DEFAULT 0,
                last_attempt_at INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending',
                error_msg TEXT,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
            );

            CREATE INDEX IF NOT EXISTS idx_pu_status
                ON pending_uploads(status);

        ",
        )?;

        Ok(())
    }

    // ============================================================
    // MATCH CRUD
    // ============================================================

    pub fn insert_match(&self, m: &MatchRow) -> Result<(), StorageError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO matches
             (id, game_id, started_at, ended_at, duration_ms, map, agent, game_mode, won,
              kills, deaths, assists, recording_path, recording_size_bytes,
              analysis_status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                m.id,
                m.game_id,
                m.started_at,
                m.ended_at,
                m.duration_ms,
                m.map,
                m.agent,
                m.game_mode,
                m.won.map(|b| if b { 1i64 } else { 0i64 }),
                m.kills,
                m.deaths,
                m.assists,
                m.recording_path,
                m.recording_size_bytes,
                m.analysis_status,
            ],
        )?;
        Ok(())
    }

    pub fn update_match_end(
        &self,
        match_id: &str,
        ended_at: i64,
        duration_ms: i64,
        kills: i64,
        deaths: i64,
        assists: i64,
    ) -> Result<(), StorageError> {
        self.conn.execute(
            "UPDATE matches SET ended_at=?1, duration_ms=?2, kills=?3, deaths=?4, assists=?5
             WHERE id=?6",
            params![ended_at, duration_ms, kills, deaths, assists, match_id],
        )?;
        Ok(())
    }

    pub fn set_recording_path(&self, match_id: &str, path: &str) -> Result<(), StorageError> {
        self.conn.execute(
            "UPDATE matches SET recording_path=?1 WHERE id=?2",
            params![path, match_id],
        )?;
        Ok(())
    }

    /// Persist the user-selected agent (and optional map) onto the match row.
    /// Called when the dropdown changes so the DB always has ground truth —
    /// even if analysis fails mid-run, a re-run has the correct agent.
    /// An empty string for either field stores NULL (user cleared the choice).
    pub fn set_match_metadata(
        &self,
        match_id: &str,
        agent: Option<&str>,
        map: Option<&str>,
    ) -> Result<(), StorageError> {
        let agent_val = agent.filter(|s| !s.is_empty());
        let map_val = map.filter(|s| !s.is_empty());
        self.conn.execute(
            "UPDATE matches SET agent=?1, map=?2 WHERE id=?3",
            params![agent_val, map_val, match_id],
        )?;
        Ok(())
    }

    pub fn set_analysis_copy_path(&self, match_id: &str, path: &str) -> Result<(), StorageError> {
        self.conn.execute(
            "UPDATE matches SET analysis_copy_path=?1 WHERE id=?2",
            params![path, match_id],
        )?;
        Ok(())
    }

    pub fn get_analysis_copy_path(&self, match_id: &str) -> Result<Option<String>, StorageError> {
        let result: rusqlite::Result<Option<String>> = self.conn.query_row(
            "SELECT analysis_copy_path FROM matches WHERE id=?1",
            params![match_id],
            |row| row.get(0),
        );
        match result {
            Ok(v) => Ok(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(StorageError::Db(e)),
        }
    }

    pub fn get_match(&self, match_id: &str) -> Result<Option<MatchRow>, StorageError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, game_id, started_at, ended_at, duration_ms, map, agent,
                    game_mode, won, kills, deaths, assists, recording_path,
                    recording_size_bytes, analysis_status, created_at
             FROM matches WHERE id=?1",
        )?;

        let result = stmt.query_row(params![match_id], |row| {
            Ok(MatchRow {
                id: row.get(0)?,
                game_id: row.get(1)?,
                started_at: row.get(2)?,
                ended_at: row.get(3)?,
                duration_ms: row.get(4)?,
                map: row.get(5)?,
                agent: row.get(6)?,
                game_mode: row.get(7)?,
                won: row.get::<_, Option<i64>>(8)?.map(|v| v != 0),
                kills: row.get(9)?,
                deaths: row.get(10)?,
                assists: row.get(11)?,
                recording_path: row.get(12)?,
                recording_size_bytes: row.get(13)?,
                analysis_status: row.get(14)?,
                created_at: row.get(15)?,
                // match_number only meaningful in listing context (computed by
                // list_matches CTE). Single-row fetches like get_match don't
                // need it and never reach the UI's "Game #N" label, so 0 is a
                // safe sentinel.
                match_number: 0,
            })
        });

        match result {
            Ok(m) => Ok(Some(m)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(StorageError::Db(e)),
        }
    }

    /// Paginated match listing.
    ///
    /// Arguments:
    ///   - `limit`          — page size (upper-bounded by caller; we don't cap here)
    ///   - `offset`         — rows to skip (page 1 = 0, page 2 = limit, etc.)
    ///   - `analysed_only`  — if true, only rows where analysis_status='done'
    ///
    /// Sort: newest first (started_at DESC).
    pub fn list_matches(
        &self,
        limit: usize,
        offset: usize,
        analysed_only: bool,
    ) -> Result<Vec<MatchRow>, StorageError> {
        // Build query with optional filter. A CTE computes each match's
        // 1-indexed rank across ALL matches (by start time ascending) so the
        // "Game #N" label is stable regardless of whether the caller filtered
        // for analysed-only matches. Oldest = 1, newest = total. This makes
        // the same physical match show the same number in history + coaching.
        let sql = if analysed_only {
            "WITH ranked AS (
                SELECT id, game_id, started_at, ended_at, duration_ms, map, agent,
                       game_mode, won, kills, deaths, assists, recording_path,
                       recording_size_bytes, analysis_status, created_at,
                       ROW_NUMBER() OVER (ORDER BY started_at ASC) AS match_number
                FROM matches
             )
             SELECT id, game_id, started_at, ended_at, duration_ms, map, agent,
                    game_mode, won, kills, deaths, assists, recording_path,
                    recording_size_bytes, analysis_status, created_at, match_number
             FROM ranked
             WHERE analysis_status = 'done'
             ORDER BY started_at DESC
             LIMIT ?1 OFFSET ?2"
        } else {
            "WITH ranked AS (
                SELECT id, game_id, started_at, ended_at, duration_ms, map, agent,
                       game_mode, won, kills, deaths, assists, recording_path,
                       recording_size_bytes, analysis_status, created_at,
                       ROW_NUMBER() OVER (ORDER BY started_at ASC) AS match_number
                FROM matches
             )
             SELECT id, game_id, started_at, ended_at, duration_ms, map, agent,
                    game_mode, won, kills, deaths, assists, recording_path,
                    recording_size_bytes, analysis_status, created_at, match_number
             FROM ranked
             ORDER BY started_at DESC
             LIMIT ?1 OFFSET ?2"
        };
        let mut stmt = self.conn.prepare(sql)?;

        let rows = stmt.query_map(params![limit as i64, offset as i64], |row| {
            Ok(MatchRow {
                id: row.get(0)?,
                game_id: row.get(1)?,
                started_at: row.get(2)?,
                ended_at: row.get(3)?,
                duration_ms: row.get(4)?,
                map: row.get(5)?,
                agent: row.get(6)?,
                game_mode: row.get(7)?,
                won: row.get::<_, Option<i64>>(8)?.map(|v| v != 0),
                kills: row.get(9)?,
                deaths: row.get(10)?,
                assists: row.get(11)?,
                recording_path: row.get(12)?,
                recording_size_bytes: row.get(13)?,
                analysis_status: row.get(14)?,
                created_at: row.get(15)?,
                match_number: row.get(16)?,
            })
        })?;

        let mut result: Vec<MatchRow> = rows.collect::<SqlResult<Vec<_>>>()?;
        // Backfill size from filesystem for rows where it wasn't stored
        for row in &mut result {
            if let Some(ref path) = row.recording_path {
                if let Ok(meta) = std::fs::metadata(path) {
                    let size = meta.len() as i64;
                    if row.recording_size_bytes.is_none() || row.recording_size_bytes == Some(0) {
                        row.recording_size_bytes = Some(size);
                    }
                }
            }
        }
        Ok(result)
    }

    /// Count of matches for pagination total. Mirrors `list_matches`'s filter.
    pub fn count_matches(&self, analysed_only: bool) -> Result<usize, StorageError> {
        let sql = if analysed_only {
            "SELECT COUNT(*) FROM matches WHERE analysis_status = 'done'"
        } else {
            "SELECT COUNT(*) FROM matches"
        };
        let mut stmt = self.conn.prepare(sql)?;
        let count: i64 = stmt.query_row([], |row| row.get(0))?;
        Ok(count.max(0) as usize)
    }

    // ============================================================
    // EVENT STORAGE
    // ============================================================

    pub fn insert_events(&self, events: &[GameEvent]) -> Result<(), StorageError> {
        let tx = self.conn.unchecked_transaction()?;

        for event in events {
            tx.execute(
                "INSERT OR IGNORE INTO events
                 (id, match_id, timestamp_ms, event_type_id, confidence, detection_sources, data)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    event.id.to_string(),
                    "", // match_id will be set separately
                    event.timestamp_ms as i64,
                    event.event_type_id,
                    event.confidence as f64,
                    serde_json::to_string(&event.detection_sources)?,
                    serde_json::to_string(&event.data)?,
                ],
            )?;
        }

        tx.commit()?;
        Ok(())
    }

    pub fn insert_events_for_match(
        &self,
        match_id: &str,
        events: &[GameEvent],
    ) -> Result<(), StorageError> {
        let tx = self.conn.unchecked_transaction()?;

        for event in events {
            tx.execute(
                "INSERT OR IGNORE INTO events
                 (id, match_id, timestamp_ms, event_type_id, confidence, detection_sources, data)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    event.id.to_string(),
                    match_id,
                    event.timestamp_ms as i64,
                    event.event_type_id,
                    event.confidence as f64,
                    serde_json::to_string(&event.detection_sources)?,
                    serde_json::to_string(&event.data)?,
                ],
            )?;
        }

        tx.commit()?;
        Ok(())
    }

    pub fn get_events_for_match(&self, match_id: &str) -> Result<Vec<EventRow>, StorageError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, match_id, timestamp_ms, event_type_id, confidence, detection_sources, data
             FROM events WHERE match_id=?1 ORDER BY timestamp_ms ASC",
        )?;

        let rows = stmt.query_map(params![match_id], |row| {
            Ok(EventRow {
                id: row.get(0)?,
                match_id: row.get(1)?,
                timestamp_ms: row.get(2)?,
                event_type_id: row.get(3)?,
                confidence: row.get(4)?,
                detection_sources: row.get(5)?,
                data: row.get(6)?,
            })
        })?;

        Ok(rows.collect::<SqlResult<Vec<_>>>()?)
    }

    // ============================================================
    // SETTINGS
    // ============================================================

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, StorageError> {
        let result: rusqlite::Result<String> = self.conn.query_row(
            "SELECT value FROM settings WHERE key=?1",
            params![key],
            |row| row.get(0),
        );

        match result {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(StorageError::Db(e)),
        }
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), StorageError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_all_settings(
        &self,
    ) -> Result<std::collections::HashMap<String, String>, StorageError> {
        let mut stmt = self.conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let map = rows.collect::<SqlResult<Vec<_>>>()?.into_iter().collect();
        Ok(map)
    }

    /// Remove matches that have no usable data:
    ///   - Recording file missing or 0 bytes on disk
    ///   - No recording AND no meaningful stats (0 kills, 0 deaths)
    pub fn cleanup_stale_matches(&self) -> Result<usize, StorageError> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, recording_path FROM matches")?;
        let stale_ids: Vec<String> = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })?
            .filter_map(|r| r.ok())
            .filter(|(_, path)| {
                match path {
                    Some(p) if !p.is_empty() => {
                        // Has a recording_path — check if file is missing or 0 bytes
                        match std::fs::metadata(p) {
                            Ok(m) => m.len() == 0,
                            Err(_) => true,
                        }
                    }
                    _ => {
                        // No recording path at all — this entry is orphaned
                        true
                    }
                }
            })
            .map(|(id, _)| id)
            .collect();

        let count = stale_ids.len();
        for id in &stale_ids {
            let _ = self.delete_match(id);
            log::info!("Cleaned up stale match: {id}");
        }
        Ok(count)
    }

    // ============================================================
    // SCHEMA MIGRATION (adds columns to existing older databases)
    // ============================================================

    fn migrate_schema(&self) {
        // Versioned migration system: each migration runs once.
        // We track applied versions in a schema_version table.
        let _ = self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
            );",
        );

        let current_version: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);

        let migrations: &[(i64, &str)] = &[
            (
                1,
                "ALTER TABLE coaching_reports ADD COLUMN match_id TEXT REFERENCES matches(id)",
            ),
            (2, "SELECT 1"), // no-op (was: add clip_path to death_classifications, table removed)
            (3, "ALTER TABLE matches ADD COLUMN game_mode TEXT"),
            (
                4,
                "ALTER TABLE matches RENAME COLUMN tier2_status TO analysis_status",
            ),
            (5, "ALTER TABLE matches DROP COLUMN tier3_status"),
            (6, "ALTER TABLE matches ADD COLUMN analysis_copy_path TEXT"),
        ];

        for (version, sql) in migrations {
            if *version > current_version {
                match self.conn.execute(sql, []) {
                    Ok(_) => {
                        let _ = self.conn.execute(
                            "INSERT INTO schema_migrations (version) VALUES (?1)",
                            params![version],
                        );
                        log::info!("Applied migration v{version}");
                    }
                    Err(e) => {
                        // Column already exists errors are safe to ignore
                        log::debug!("Migration v{version} skipped (likely already applied): {e}");
                        let _ = self.conn.execute(
                            "INSERT OR IGNORE INTO schema_migrations (version) VALUES (?1)",
                            params![version],
                        );
                    }
                }
            }
        }
    }

    /// Delete a match and all associated data from the database.
    pub fn delete_match(&self, match_id: &str) -> Result<(), StorageError> {
        self.conn
            .execute("DELETE FROM events WHERE match_id=?1", params![match_id])?;
        self.conn.execute(
            "DELETE FROM coaching_reports WHERE match_id=?1",
            params![match_id],
        )?;
        self.conn.execute(
            "DELETE FROM deep_analysis_jobs WHERE match_id=?1",
            params![match_id],
        )?;
        self.conn.execute(
            "DELETE FROM deep_coaching_reports WHERE match_id=?1",
            params![match_id],
        )?;
        self.conn
            .execute("DELETE FROM matches WHERE id=?1", params![match_id])?;
        Ok(())
    }

    // ============================================================
    // ANALYSIS STATUS
    // ============================================================

    pub fn update_analysis_status(&self, match_id: &str, status: &str) -> Result<(), StorageError> {
        self.conn.execute(
            "UPDATE matches SET analysis_status=?1 WHERE id=?2",
            params![status, match_id],
        )?;
        Ok(())
    }

    // ============================================================
    // COACHING REPORTS
    // ============================================================

    // ============================================================
    // TREND REPORTS
    // ============================================================

    pub fn insert_trend_report(&self, r: &TrendReportRow) -> Result<(), StorageError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO trend_reports
             (id, generated_at, matches_analyzed, report_json, top_patterns)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                r.id,
                r.generated_at,
                r.matches_analyzed,
                r.report_json,
                r.top_patterns
            ],
        )?;
        Ok(())
    }

    pub fn get_latest_trend_report(&self) -> Result<Option<TrendReportRow>, StorageError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, generated_at, matches_analyzed, report_json, top_patterns
             FROM trend_reports ORDER BY generated_at DESC LIMIT 1",
        )?;
        let result = stmt.query_row([], |row| {
            Ok(TrendReportRow {
                id: row.get(0)?,
                generated_at: row.get(1)?,
                matches_analyzed: row.get(2)?,
                report_json: row.get(3)?,
                top_patterns: row.get(4)?,
            })
        });
        match result {
            Ok(r) => Ok(Some(r)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(StorageError::Db(e)),
        }
    }

    // ============================================================
    // DEEP ANALYSIS JOBS
    // ============================================================

    pub fn insert_deep_analysis_job(&self, job: &DeepAnalysisJobRow) -> Result<(), StorageError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO deep_analysis_jobs
             (id, match_id, server_job_id, server_report_id, status, error_msg, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                job.id, job.match_id, job.server_job_id, job.server_report_id,
                job.status, job.error_msg, job.created_at, job.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn update_deep_analysis_job(
        &self,
        id: &str,
        server_job_id: Option<&str>,
        server_report_id: Option<&str>,
        status: &str,
        error_msg: Option<&str>,
    ) -> Result<(), StorageError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        self.conn.execute(
            "UPDATE deep_analysis_jobs
             SET server_job_id=COALESCE(?2, server_job_id),
                 server_report_id=COALESCE(?3, server_report_id),
                 status=?4, error_msg=?5, updated_at=?6
             WHERE id=?1",
            params![id, server_job_id, server_report_id, status, error_msg, now],
        )?;
        Ok(())
    }

    pub fn get_deep_analysis_job_by_match(
        &self,
        match_id: &str,
    ) -> Result<Option<DeepAnalysisJobRow>, StorageError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, match_id, server_job_id, server_report_id, status, error_msg, created_at, updated_at
             FROM deep_analysis_jobs WHERE match_id=?1 ORDER BY created_at DESC LIMIT 1",
        )?;

        let result = stmt.query_row(params![match_id], |row| {
            Ok(DeepAnalysisJobRow {
                id: row.get(0)?,
                match_id: row.get(1)?,
                server_job_id: row.get(2)?,
                server_report_id: row.get(3)?,
                status: row.get(4)?,
                error_msg: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        });

        match result {
            Ok(r) => Ok(Some(r)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(StorageError::Db(e)),
        }
    }

    // ============================================================
    // DEEP COACHING REPORTS
    // ============================================================

    pub fn insert_deep_coaching_report(
        &self,
        r: &DeepCoachingReportRow,
    ) -> Result<(), StorageError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO deep_coaching_reports
             (id, match_id, server_report_id, report_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                r.id,
                r.match_id,
                r.server_report_id,
                r.report_json,
                r.created_at
            ],
        )?;
        Ok(())
    }

    pub fn get_deep_coaching_report(
        &self,
        match_id: &str,
    ) -> Result<Option<DeepCoachingReportRow>, StorageError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, match_id, server_report_id, report_json, created_at
             FROM deep_coaching_reports WHERE match_id=?1 ORDER BY created_at DESC LIMIT 1",
        )?;

        let result = stmt.query_row(params![match_id], |row| {
            Ok(DeepCoachingReportRow {
                id: row.get(0)?,
                match_id: row.get(1)?,
                server_report_id: row.get(2)?,
                report_json: row.get(3)?,
                created_at: row.get(4)?,
            })
        });

        match result {
            Ok(r) => Ok(Some(r)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(StorageError::Db(e)),
        }
    }

    // ============================================================
    // PENDING UPLOADS (offline retry queue)
    // ============================================================

    pub fn insert_pending_upload(&self, row: &PendingUploadRow) -> Result<(), StorageError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO pending_uploads
             (id, match_id, job_type, payload_json, retry_count, last_attempt_at, status, error_msg, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                row.id, row.match_id, row.job_type, row.payload_json,
                row.retry_count, row.last_attempt_at, row.status, row.error_msg, row.created_at,
            ],
        )?;
        Ok(())
    }

    /// Get all pending uploads ready for retry (exponential backoff).
    /// Returns items whose backoff has elapsed: last_attempt_at + (2^retry_count * 1000) < now.
    pub fn get_retriable_uploads(&self) -> Result<Vec<PendingUploadRow>, StorageError> {
        let now = crate::now_ms();
        let mut stmt = self.conn.prepare(
            "SELECT id, match_id, job_type, payload_json, retry_count, last_attempt_at, status, error_msg, created_at
             FROM pending_uploads
             WHERE status = 'pending'
               AND (last_attempt_at + (1 << MIN(retry_count, 6)) * 1000) < ?1
             ORDER BY created_at ASC
             LIMIT 5",
        )?;

        let rows = stmt
            .query_map(params![now], |row| {
                Ok(PendingUploadRow {
                    id: row.get(0)?,
                    match_id: row.get(1)?,
                    job_type: row.get(2)?,
                    payload_json: row.get(3)?,
                    retry_count: row.get(4)?,
                    last_attempt_at: row.get(5)?,
                    status: row.get(6)?,
                    error_msg: row.get(7)?,
                    created_at: row.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(rows)
    }

    pub fn update_pending_upload_retry(
        &self,
        id: &str,
        error_msg: Option<&str>,
    ) -> Result<(), StorageError> {
        let now = crate::now_ms();
        self.conn.execute(
            "UPDATE pending_uploads
             SET retry_count = retry_count + 1, last_attempt_at = ?2, error_msg = ?3,
                 status = CASE WHEN retry_count >= 9 THEN 'failed_permanent' ELSE 'pending' END
             WHERE id = ?1",
            params![id, now, error_msg],
        )?;
        Ok(())
    }

    pub fn delete_pending_upload(&self, id: &str) -> Result<(), StorageError> {
        self.conn
            .execute("DELETE FROM pending_uploads WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn pending_upload_count(&self) -> Result<i64, StorageError> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM pending_uploads WHERE status = 'pending'",
            [],
            |row| row.get(0),
        )?;
        Ok(count)
    }
}
