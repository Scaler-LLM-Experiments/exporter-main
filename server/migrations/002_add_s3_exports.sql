-- Add S3 export tracking
-- Run this with: psql $DATABASE_URL -f server/migrations/002_add_s3_exports.sql

-- S3 exports table (tracks uploaded ZIPs)
CREATE TABLE IF NOT EXISTS s3_exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Link to job
  job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,

  -- File information
  frame_name VARCHAR(255) NOT NULL, -- e.g., "00560"
  file_name VARCHAR(255) NOT NULL, -- e.g., "00560.zip"
  s3_url TEXT NOT NULL, -- Full S3 URL
  s3_key TEXT NOT NULL, -- S3 object key (e.g., "00560.zip")

  -- File metadata
  file_size_bytes BIGINT, -- Size of uploaded ZIP
  variant_count INT, -- Number of variants in this ZIP

  -- Timing
  uploaded_at TIMESTAMP DEFAULT NOW(),

  -- User tracking
  user_email VARCHAR(255)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_s3_exports_job_id ON s3_exports(job_id);
CREATE INDEX IF NOT EXISTS idx_s3_exports_frame_name ON s3_exports(frame_name);
CREATE INDEX IF NOT EXISTS idx_s3_exports_user_email ON s3_exports(user_email) WHERE user_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_s3_exports_uploaded ON s3_exports(uploaded_at DESC);

-- Success message
DO $$
BEGIN
  RAISE NOTICE 'Migration 002_add_s3_exports.sql completed successfully!';
  RAISE NOTICE 'Table created: s3_exports';
END $$;
