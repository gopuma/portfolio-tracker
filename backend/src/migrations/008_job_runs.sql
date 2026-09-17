-- Last run of each scheduled job, so a backend that was down at its scheduled time can
-- tell on startup that it missed one and catch up (see jobs/dailyPriceJob.js).
CREATE TABLE IF NOT EXISTS job_runs (
  name             VARCHAR(64) PRIMARY KEY,
  last_started_at  DATETIME NULL COMMENT 'UTC',
  last_finished_at DATETIME NULL COMMENT 'UTC',
  last_reason      VARCHAR(16) NULL COMMENT 'scheduled | catch-up',
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
