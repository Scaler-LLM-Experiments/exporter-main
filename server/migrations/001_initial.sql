-- Initial schema for Figma Exporter AI Plugin
-- Run this with: psql $DATABASE_URL -f server/migrations/001_initial.sql

-- Jobs table (tracks all operations)
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(50) NOT NULL, -- 'rename-layers', 'generate-edits'
  status VARCHAR(20) NOT NULL DEFAULT 'processing', -- 'processing', 'completed', 'failed'

  -- Job metadata (NOT full payloads with images!)
  layer_count INT, -- For rename-layers
  frame_name VARCHAR(255), -- For generate-edits
  variant_count INT, -- For generate-edits (usually 5)

  -- Timing
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  duration_ms INT,

  -- Error tracking
  error_message TEXT,
  error_stack TEXT,

  -- User tracking (userEmail is optional for backward compatibility)
  user_email VARCHAR(255), -- Figma user email (can be null for old jobs)
  user_id VARCHAR(255), -- Figma user ID (if available)
  ip_address INET
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_user_email ON jobs(user_email) WHERE user_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id) WHERE user_id IS NOT NULL;

-- Usage stats table (aggregated daily)
CREATE TABLE IF NOT EXISTS usage_stats (
  date DATE NOT NULL,
  operation_type VARCHAR(50) NOT NULL,

  -- Counts
  total_jobs INT DEFAULT 0,
  successful_jobs INT DEFAULT 0,
  failed_jobs INT DEFAULT 0,

  -- Aggregated metrics
  total_layers INT DEFAULT 0, -- For rename-layers
  avg_duration_ms NUMERIC(10, 2),
  p50_duration_ms INT,
  p95_duration_ms INT,
  p99_duration_ms INT,

  -- Timestamps
  updated_at TIMESTAMP DEFAULT NOW(),

  PRIMARY KEY (date, operation_type)
);

-- Create an index for querying recent stats
CREATE INDEX IF NOT EXISTS idx_usage_stats_date ON usage_stats(date DESC);

-- Function to aggregate daily stats (run via cron or scheduled job)
CREATE OR REPLACE FUNCTION aggregate_daily_stats(target_date DATE)
RETURNS void AS $$
BEGIN
  INSERT INTO usage_stats (date, operation_type, total_jobs, successful_jobs, failed_jobs, total_layers, avg_duration_ms)
  SELECT
    target_date,
    type AS operation_type,
    COUNT(*) AS total_jobs,
    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS successful_jobs,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_jobs,
    SUM(COALESCE(layer_count, 0)) AS total_layers,
    AVG(duration_ms) AS avg_duration_ms
  FROM jobs
  WHERE DATE(created_at) = target_date
  GROUP BY type
  ON CONFLICT (date, operation_type)
  DO UPDATE SET
    total_jobs = EXCLUDED.total_jobs,
    successful_jobs = EXCLUDED.successful_jobs,
    failed_jobs = EXCLUDED.failed_jobs,
    total_layers = EXCLUDED.total_layers,
    avg_duration_ms = EXCLUDED.avg_duration_ms,
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- Success message
DO $$
BEGIN
  RAISE NOTICE 'Migration 001_initial.sql completed successfully!';
  RAISE NOTICE 'Tables created: jobs, usage_stats';
  RAISE NOTICE 'Function created: aggregate_daily_stats(date)';
END $$;
