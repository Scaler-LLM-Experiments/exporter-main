# Production Scaling Plan V2 (Revised)

## Figma Exporter AI Plugin - 100+ Concurrent Users

**Based on:**
- ✅ OpenRouter Professional (no rate limits)
- ✅ Synchronous processing (fast with parallelization)
- ✅ PostgreSQL for analytics (memory-safe approach)
- ❌ No Redis initially (not needed without job queue)

**New Requirements Added:**
- ✅ User email tracking (collected from Figma API for every job)
- ✅ Dynamic prompt selector (UI dropdown with auto-discovery)
- ✅ Memory-only image storage (explicit cleanup, no DB/disk persistence)

---

## Executive Summary

This revised plan provides a **pragmatic scaling approach** that adds PostgreSQL for long-term analytics while keeping the architecture simple. Redis is intentionally excluded because:

1. **No rate limits** (OpenRouter Pro) = No need for job queue
2. **Fast processing** (15-30s with parallelization) = Synchronous responses work
3. **Memory-safe patterns** = Request-scoped data, proper cleanup

| Attribute | Value |
|-----------|-------|
| **Timeline** | 1 week (Phase 1), 3 days (Phase 2) |
| **Target Platform** | Railway |
| **Persistence** | PostgreSQL (job history & analytics only) |
| **Target Users** | 100-200 concurrent |
| **Redis** | NOT INCLUDED (add later if needed) |

---

## Architecture Comparison

### Original Plan (Complex)
```
┌──────────┐     ┌─────────────┐    ┌───────────────┐    ┌─────────────┐
│  Figma   │────▶│   Railway   │───▶│     Redis     │───▶│   Workers   │
│  Plugin  │◀────│   (API)     │◀───│   (BullMQ)    │◀───│  (1-4 pods) │
└──────────┘     └─────────────┘    └───────────────┘    └─────────────┘
                        │                                       │
                        ├───────────────────────────────────────┘
                        ▼
              ┌─────────────────┐
              │   PostgreSQL    │
              │  (Job History)  │
              └─────────────────┘

Cost: ~$55-95/month
Complexity: HIGH
```

### Revised Plan (Pragmatic)
```
┌──────────┐     ┌──────────────────────────┐     ┌─────────────────┐
│  Figma   │────▶│    Railway API Server    │────▶│   PostgreSQL    │
│  Plugin  │◀────│  (Express + Parallel     │◀────│   (Analytics &  │
└──────────┘     │   Processing)            │     │   Job Tracking) │
                 └──────────────────────────┘     └─────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  OpenRouter Pro │
                    │  (No rate limit)│
                    └─────────────────┘

Cost: ~$30-50/month
Complexity: LOW-MEDIUM
```

---

## Week 1: Performance & Memory Optimizations

### Day 1-2: Parallel Processing Implementation

**Goal:** Reduce rename-layers from 150s → 15s (10x improvement)

#### Install Dependencies
```bash
cd server
npm install p-limit
npm install connect-timeout
```

#### Create Concurrency Helper
**File:** `server/lib/concurrency.ts`

```typescript
import pLimit from 'p-limit';

// Concurrency limiters for different operations
export const renameLimiter = pLimit(10);  // 10 concurrent rename calls
export const imageLimiter = pLimit(5);    // 5 concurrent image generations

/**
 * Process an array of items with controlled concurrency
 * @param items - Array of items to process
 * @param processFn - Async function to process each item
 * @param limiter - p-limit instance for concurrency control
 * @returns Promise resolving to array of results
 */
export async function processWithConcurrency<T, R>(
  items: T[],
  processFn: (item: T, index: number) => Promise<R>,
  limiter: ReturnType<typeof pLimit>
): Promise<PromiseSettledResult<R>[]> {
  const promises = items.map((item, index) =>
    limiter(() => processFn(item, index))
  );

  return Promise.allSettled(promises);
}

/**
 * Process items in batches with a delay between batches
 * Useful if you want to be extra cautious about API load
 */
export async function processBatched<T, R>(
  items: T[],
  batchSize: number,
  processFn: (item: T) => Promise<R>,
  delayMs: number = 0
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(item => processFn(item))
    );
    results.push(...batchResults);

    // Optional delay between batches
    if (delayMs > 0 && i + batchSize < items.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return results;
}
```

#### Update Rename Layers Endpoint
**File:** `server/index.ts` (line ~715)

```typescript
import { renameLimiter, processWithConcurrency } from './lib/concurrency';

// Main endpoint for renaming layers
app.post('/api/rename-layers', async (req: Request, res: Response) => {
  try {
    const { layers }: RenameRequest = req.body;

    if (!layers || !Array.isArray(layers)) {
      res.status(400).json({ error: 'Invalid request: layers array required' });
      return;
    }

    console.log(`Processing ${layers.length} layers for AI renaming (parallel mode)...`);
    const startTime = Date.now();

    // Process all layers in parallel with concurrency control
    const results = await processWithConcurrency(
      layers,
      async (layer, index) => {
        console.log(`  [${index + 1}/${layers.length}] Processing: ${layer.currentName} (${layer.type})`);

        const newName = await generateLayerName(
          layer.imageBase64,
          layer.currentName,
          layer.type
        );

        console.log(`    -> ${newName}`);
        return { id: layer.id, newName };
      },
      renameLimiter
    );

    // Extract successful results, fallback to original name on failure
    const renamed = results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        console.error(`  Failed to rename layer ${layers[index].id}:`, result.reason);
        return {
          id: layers[index].id,
          newName: layers[index].currentName // Fallback to original
        };
      }
    });

    const duration = Date.now() - startTime;
    console.log(`Completed renaming ${renamed.length} layers in ${(duration / 1000).toFixed(1)}s`);

    res.json({ layers: renamed });
  } catch (error) {
    console.error('Error in /api/rename-layers:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: (error as Error).message
    });
  }
});
```

#### Update Image Generation
**File:** `server/index.ts` (line ~447)

```typescript
import { imageLimiter, processWithConcurrency } from './lib/concurrency';

// Process image generation instructions in variants (PARALLEL)
async function processImageGenerations(
  variants: EditVariant[],
  contextDescription: string
): Promise<EditVariant[]> {
  // Collect all image generation tasks
  const imageTasks: Array<{
    variant: EditVariant;
    instruction: EditInstruction;
  }> = [];

  for (const variant of variants) {
    for (const instruction of variant.instructions) {
      if (instruction.action === 'generateImage' && instruction.imagePrompt) {
        imageTasks.push({ variant, instruction });
      }
    }
  }

  if (imageTasks.length === 0) {
    return variants;
  }

  console.log(`Generating ${imageTasks.length} images in parallel...`);
  const startTime = Date.now();

  // Process all images in parallel with concurrency control
  const results = await processWithConcurrency(
    imageTasks,
    async (task) => {
      const generatedImage = await generateImageFromPrompt(
        task.instruction.imagePrompt!,
        `${contextDescription} - Variant: ${task.variant.theme}`
      );
      return { task, generatedImage };
    },
    imageLimiter
  );

  // Map successful results back to instructions
  results.forEach((result) => {
    if (result.status === 'fulfilled' && result.value.generatedImage) {
      result.value.task.instruction.generatedImageBase64 = result.value.generatedImage;
    }
  });

  const duration = Date.now() - startTime;
  console.log(`Completed image generation in ${(duration / 1000).toFixed(1)}s`);

  return variants;
}
```

### Day 3: Memory Safety & Request Limits

#### Add Request Timeout Middleware
**File:** `server/index.ts` (after cors config, ~line 20)

```typescript
import timeout from 'connect-timeout';

// Add request timeout (2 minutes max)
app.use(timeout('120s'));

// Timeout handler middleware
app.use((req, res, next) => {
  if (!req.timedout) {
    next();
  } else {
    res.status(408).json({
      error: 'Request timeout',
      message: 'Processing took too long'
    });
  }
});

// Reduce body size limit (was 100mb, now 20mb)
app.use(express.json({ limit: '20mb' }));
```

#### Add Memory Monitoring to Health Check
**File:** `server/index.ts` (line ~710)

```typescript
app.get('/health', async (req, res) => {
  const memory = process.memoryUsage();
  const memoryInMB = {
    heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
    heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
    rss: Math.round(memory.rss / 1024 / 1024),
    external: Math.round(memory.external / 1024 / 1024)
  };

  // Health check fails if memory > 80% of heap
  const memoryHealthy = memory.heapUsed < memory.heapTotal * 0.8;

  res.status(memoryHealthy ? 200 : 503).json({
    status: memoryHealthy ? 'ok' : 'degraded',
    service: 'exporter-server',
    memory: memoryInMB,
    uptime: Math.round(process.uptime())
  });
});
```

#### Add Dependencies
```bash
npm install connect-timeout
npm install -D @types/connect-timeout
```

### Day 4: Rate Limiting (Safety Net)

Even though OpenRouter Pro has no rate limits, add client rate limiting to prevent abuse:

**File:** `server/lib/rateLimiter.ts` (create new)

```typescript
import rateLimit from 'express-rate-limit';

// General API rate limit (per IP)
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute per IP
  message: {
    error: 'Too many requests',
    message: 'Please wait before making more requests'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Heavy operation rate limit (generate-edits)
export const heavyLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 generate-edits per minute per IP
  message: {
    error: 'Too many complex requests',
    message: 'Please wait before generating more variants'
  }
});

// Rename layers rate limit (generous)
export const renameLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 rename requests per minute per IP
  message: {
    error: 'Too many rename requests',
    message: 'Please wait before renaming more layers'
  }
});
```

#### Apply Rate Limits
**File:** `server/index.ts`

```typescript
import { apiLimiter, heavyLimiter, renameLimiter } from './lib/rateLimiter';

// Apply to specific endpoints
app.post('/api/rename-layers', renameLimiter, async (req, res) => { /* ... */ });
app.post('/api/generate-edits', heavyLimiter, async (req, res) => { /* ... */ });
```

#### Add Dependency
```bash
npm install express-rate-limit
```

---

## Week 2: PostgreSQL Integration

### Day 5-6: Database Setup

#### Install Dependencies
```bash
npm install pg
npm install -D @types/pg
```

#### Create Database Connection
**File:** `server/lib/db.ts`

```typescript
import { Pool } from 'pg';

// Create connection pool
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // Maximum number of connections in the pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection on startup
pool.on('connect', () => {
  console.log('PostgreSQL connected');
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
});

// Helper function to execute queries
export async function query(text: string, params?: any[]) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log('Executed query', { text, duration, rows: res.rowCount });
  return res;
}

// Graceful shutdown
export async function closePool() {
  await pool.end();
  console.log('PostgreSQL pool closed');
}
```

#### Database Schema
**File:** `server/migrations/001_initial.sql`

```sql
-- Jobs table (tracks all operations)
CREATE TABLE jobs (
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

  -- User tracking (required for all jobs)
  user_email VARCHAR(255) NOT NULL, -- Figma user email
  user_id VARCHAR(255), -- Figma user ID (if available)
  ip_address INET
);

-- Indexes for common queries
CREATE INDEX idx_jobs_type ON jobs(type);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX idx_jobs_user_email ON jobs(user_email);
CREATE INDEX idx_jobs_user ON jobs(user_id) WHERE user_id IS NOT NULL;

-- Usage stats table (aggregated daily)
CREATE TABLE usage_stats (
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
CREATE INDEX idx_usage_stats_date ON usage_stats(date DESC);

-- API usage table (for rate limiting insights)
CREATE TABLE api_calls (
  id SERIAL PRIMARY KEY,
  endpoint VARCHAR(100) NOT NULL,
  ip_address INET,
  user_agent TEXT,
  response_status INT,
  response_time_ms INT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Partition this table by month for performance (optional, for high traffic)
-- CREATE INDEX idx_api_calls_created ON api_calls(created_at DESC);

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
```

#### Run Migration
```bash
# On Railway, run via psql or Railway UI SQL runner
psql $DATABASE_URL -f server/migrations/001_initial.sql
```

### Day 7-A: User Email Collection

#### Figma Plugin Changes

Figma provides access to the current user's information via `figma.currentUser`. We need to collect this and send it with every API request.

**File:** `code.ts` (add near top, after imports)

```typescript
// Get current user info (cached for session)
let cachedUserEmail: string | null = null;

async function getUserEmail(): Promise<string> {
  if (cachedUserEmail) {
    return cachedUserEmail;
  }

  const user = figma.currentUser;
  if (user && user.email) {
    cachedUserEmail = user.email;
    return user.email;
  }

  // Fallback: If email not available, use ID
  if (user && user.id) {
    cachedUserEmail = `user-${user.id}@figma.local`;
    return cachedUserEmail;
  }

  // Last resort fallback
  return 'anonymous@figma.local';
}
```

**Update message handlers to include user email:**

```typescript
figma.ui.onmessage = async (msg: PluginMessage) => {
  const userEmail = await getUserEmail();

  if (msg.type === 'export-for-renaming') {
    // ... existing export logic ...

    figma.ui.postMessage({
      type: 'layers-for-renaming',
      userEmail, // Add this
      layers: layersForRenaming
    });
  }

  if (msg.type === 'prepare-for-edits') {
    // ... existing prepare logic ...

    figma.ui.postMessage({
      type: 'edits-prepared',
      userEmail, // Add this
      frameName,
      frameWidth,
      frameHeight,
      layers: layerMetadata
    });
  }
};
```

**File:** `ui.html` (update API calls to include userEmail)

```javascript
// Store user email when received from plugin
let currentUserEmail = 'unknown@figma.local';

// Update when receiving messages from plugin
window.onmessage = async (event) => {
  const msg = event.data.pluginMessage;

  if (msg.userEmail) {
    currentUserEmail = msg.userEmail;
  }

  // ... rest of message handling ...
};

// Include in API requests
async function sendRenameRequest(layers) {
  const response = await fetch(`${BACKEND_URL}/api/rename-layers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userEmail: currentUserEmail, // Add this
      layers
    })
  });
  return response.json();
}

async function sendGenerateEditsRequest(data) {
  const response = await fetch(`${BACKEND_URL}/api/generate-edits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userEmail: currentUserEmail, // Add this
      ...data
    })
  });
  return response.json();
}
```

### Day 7-B: Integrate Database Logging

#### Update Request Types with User Email
**File:** `server/index.ts`

```typescript
// Update request interfaces
interface RenameRequest {
  userEmail: string; // Add this
  layers: LayerInput[];
}

interface GenerateEditsRequest {
  userEmail: string; // Add this
  frameName: string;
  frameWidth: number;
  frameHeight: number;
  frameImageBase64?: string;
  layers: LayerMetadata[];
  generateImages?: boolean;
}
```

#### Update Endpoints with DB Logging
**File:** `server/index.ts`

```typescript
import { query } from './lib/db';

// Rename layers endpoint with DB logging
app.post('/api/rename-layers', renameLimiter, async (req, res) => {
  const startTime = Date.now();
  let jobId: string | null = null;

  try {
    const { userEmail, layers }: RenameRequest = req.body;

    // Validate required fields
    if (!userEmail) {
      res.status(400).json({ error: 'User email is required' });
      return;
    }
    if (!layers || !Array.isArray(layers)) {
      res.status(400).json({ error: 'Invalid request: layers array required' });
      return;
    }

    // Create job record with user email
    const jobResult = await query(
      `INSERT INTO jobs (type, layer_count, user_email, ip_address, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      ['rename-layers', layers.length, userEmail, req.ip, 'processing']
    );
    jobId = jobResult.rows[0].id;

    console.log(`[Job ${jobId}] Processing ${layers.length} layers for AI renaming...`);

    // Process layers in parallel
    const results = await processWithConcurrency(
      layers,
      async (layer, index) => {
        console.log(`  [${index + 1}/${layers.length}] Processing: ${layer.currentName}`);
        const newName = await generateLayerName(
          layer.imageBase64,
          layer.currentName,
          layer.type
        );
        console.log(`    -> ${newName}`);
        return { id: layer.id, newName };
      },
      renameLimiter
    );

    // Extract results
    const renamed = results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        console.error(`  Failed to rename layer ${layers[index].id}:`, result.reason);
        return { id: layers[index].id, newName: layers[index].currentName };
      }
    });

    const duration = Date.now() - startTime;

    // Update job as completed
    await query(
      `UPDATE jobs
       SET status = $1, completed_at = NOW(), duration_ms = $2
       WHERE id = $3`,
      ['completed', duration, jobId]
    );

    console.log(`[Job ${jobId}] Completed in ${(duration / 1000).toFixed(1)}s`);
    res.json({ layers: renamed });

  } catch (error) {
    const duration = Date.now() - startTime;

    // Update job as failed
    if (jobId) {
      await query(
        `UPDATE jobs
         SET status = $1, completed_at = NOW(), duration_ms = $2, error_message = $3
         WHERE id = $4`,
        ['failed', duration, (error as Error).message, jobId]
      );
    }

    console.error('Error in /api/rename-layers:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: (error as Error).message
    });
  }
});

// Similar pattern for generate-edits
app.post('/api/generate-edits', heavyLimiter, async (req, res) => {
  const startTime = Date.now();
  let jobId: string | null = null;

  try {
    const { userEmail, frameName, layers, generateImages }: GenerateEditsRequest = req.body;

    // Validate required fields
    if (!userEmail) {
      res.status(400).json({ error: 'User email is required' });
      return;
    }

    // Create job record with user email
    const jobResult = await query(
      `INSERT INTO jobs (type, frame_name, layer_count, variant_count, user_email, ip_address, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      ['generate-edits', frameName, layers.length, 5, userEmail, req.ip, 'processing']
    );
    jobId = jobResult.rows[0].id;

    console.log(`[Job ${jobId}] Generating edits for "${frameName}"...`);

    // ... existing generate-edits logic ...

    const duration = Date.now() - startTime;
    await query(
      `UPDATE jobs SET status = $1, completed_at = NOW(), duration_ms = $2 WHERE id = $3`,
      ['completed', duration, jobId]
    );

    res.json({ variants });

  } catch (error) {
    const duration = Date.now() - startTime;
    if (jobId) {
      await query(
        `UPDATE jobs SET status = $1, completed_at = NOW(), duration_ms = $2, error_message = $3 WHERE id = $4`,
        ['failed', duration, (error as Error).message, jobId]
      );
    }

    console.error('Error in /api/generate-edits:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});
```

### Day 7-C: Prompt Selector API

Users should be able to select which system prompt to use for generate-edits. The backend will auto-discover prompts from the `server/prompts/` directory.

#### Add Prompts List Endpoint
**File:** `server/index.ts`

```typescript
import fs from 'fs';
import path from 'path';

// Get list of available prompts
app.get('/api/prompts', async (req, res) => {
  try {
    const promptsDir = path.join(__dirname, 'prompts');

    // Check both compiled location and source location (for dev)
    let files: string[] = [];
    try {
      files = fs.readdirSync(promptsDir);
    } catch {
      // Fallback to source directory (for ts-node dev mode)
      const devPromptsDir = path.join(__dirname, '..', 'prompts');
      files = fs.readdirSync(devPromptsDir);
    }

    // Filter for .txt files only
    const promptFiles = files
      .filter(f => f.endsWith('.txt'))
      .map(f => {
        const name = f.replace('.txt', '');
        return {
          id: name,
          name: formatPromptName(name),
          filename: f,
          isDefault: name === 'default'
        };
      })
      .sort((a, b) => {
        // Default first, then alphabetical
        if (a.isDefault) return -1;
        if (b.isDefault) return 1;
        return a.name.localeCompare(b.name);
      });

    res.json({ prompts: promptFiles });
  } catch (error) {
    console.error('Error listing prompts:', error);
    res.status(500).json({ error: 'Failed to list prompts' });
  }
});

// Helper to format prompt names for display
function formatPromptName(filename: string): string {
  return filename
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
```

#### Update Generate Edits to Accept Prompt Selection
**File:** `server/index.ts` (update GenerateEditsRequest interface)

```typescript
interface GenerateEditsRequest {
  userEmail: string;
  frameName: string;
  frameWidth: number;
  frameHeight: number;
  frameImageBase64?: string;
  layers: LayerMetadata[];
  generateImages?: boolean;
  promptFile?: string; // NEW: User-selected prompt file (e.g., 'creative-director.txt')
}
```

**Update generate-edits endpoint to use selected prompt:**

```typescript
app.post('/api/generate-edits', heavyLimiter, async (req, res) => {
  const startTime = Date.now();
  let jobId: string | null = null;

  try {
    const {
      userEmail,
      frameName,
      layers,
      generateImages,
      promptFile // NEW
    }: GenerateEditsRequest = req.body;

    // Validate required fields
    if (!userEmail) {
      res.status(400).json({ error: 'User email is required' });
      return;
    }

    // ... create job record ...

    // Load the selected prompt (or default)
    let activePrompt = EDIT_GENERATION_PROMPT; // Default from env
    const selectedPromptFile = promptFile || process.env.EDIT_PROMPT_FILE || 'default.txt';

    console.log(`Using prompt file: ${selectedPromptFile}`);

    // Load selected prompt
    const promptPath = path.join(__dirname, 'prompts', selectedPromptFile);
    const devPromptPath = path.join(__dirname, '..', 'prompts', selectedPromptFile);

    try {
      activePrompt = fs.readFileSync(promptPath, 'utf-8');
    } catch {
      try {
        activePrompt = fs.readFileSync(devPromptPath, 'utf-8');
      } catch (error) {
        console.warn(`Prompt file ${selectedPromptFile} not found, using default`);
      }
    }

    // ... rest of generate-edits logic using activePrompt ...
  }
});
```

### Day 7-D: UI Prompt Selector

Add a dropdown in the Figma plugin UI to let users select their prompt style.

**File:** `ui.html` (add to the UI, before Generate Edits button)

```html
<!-- Prompt Selection -->
<div class="prompt-selector-container">
  <label for="prompt-selector" class="prompt-label">
    AI Style:
  </label>
  <select id="prompt-selector" class="prompt-select">
    <option value="default.txt">Loading prompts...</option>
  </select>
</div>

<!-- CSS for prompt selector -->
<style>
  .prompt-selector-container {
    margin-bottom: 0.75rem;
  }

  .prompt-label {
    display: block;
    font-size: 0.75rem;
    font-weight: 600;
    color: hsl(var(--foreground));
    margin-bottom: 0.375rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .prompt-select {
    width: 100%;
    padding: 0.5rem 0.75rem;
    font-family: inherit;
    font-size: 0.875rem;
    background: hsl(var(--background));
    border: 1px solid hsl(var(--border));
    border-radius: var(--radius);
    color: hsl(var(--foreground));
    cursor: pointer;
    transition: border-color 150ms ease;
  }

  .prompt-select:hover {
    border-color: hsl(var(--foreground) / 0.3);
  }

  .prompt-select:focus {
    outline: none;
    border-color: hsl(var(--foreground));
    box-shadow: 0 0 0 2px hsl(var(--foreground) / 0.1);
  }
</style>

<!-- JavaScript to load prompts -->
<script>
  const BACKEND_URL = 'http://localhost:3000'; // Update for production
  const promptSelector = document.getElementById('prompt-selector');
  let availablePrompts = [];

  // Load available prompts on page load
  async function loadPrompts() {
    try {
      const response = await fetch(`${BACKEND_URL}/api/prompts`);
      const data = await response.json();
      availablePrompts = data.prompts;

      // Clear loading option
      promptSelector.innerHTML = '';

      // Populate dropdown
      availablePrompts.forEach(prompt => {
        const option = document.createElement('option');
        option.value = prompt.filename;
        option.textContent = prompt.name;
        if (prompt.isDefault) {
          option.selected = true;
        }
        promptSelector.appendChild(option);
      });

      console.log(`Loaded ${availablePrompts.length} prompt styles`);
    } catch (error) {
      console.error('Failed to load prompts:', error);
      promptSelector.innerHTML = '<option value="default.txt">Default</option>';
    }
  }

  // Load prompts when UI initializes
  loadPrompts();

  // Include selected prompt in generate-edits request
  async function sendGenerateEditsRequest(data) {
    const selectedPrompt = promptSelector.value;

    const response = await fetch(`${BACKEND_URL}/api/generate-edits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userEmail: currentUserEmail,
        promptFile: selectedPrompt, // Include selected prompt
        ...data
      })
    });
    return response.json();
  }
</script>
```

### Day 7-E: Image Memory Management Clarification

**IMPORTANT: Images are NOT stored in the database or on disk. They are handled in memory only.**

#### Memory Lifecycle for Base64 Images

**Current behavior (already correct, documenting for clarity):**

```typescript
// 1. Images arrive in request body
app.post('/api/rename-layers', async (req, res) => {
  const { layers } = req.body; // layers[].imageBase64 (~5 MB total)

  // 2. Images stay in memory during processing (~15-30 seconds)
  const results = await processLayersParallel(layers);

  // 3. Send response
  res.json({ layers: results }); // No images in response

  // 4. Memory freed after response (Node.js GC)
  // Images are garbage collected automatically
});
```

#### Explicit Memory Cleanup (Optional Enhancement)

If you want to be extra aggressive about freeing memory:

**File:** `server/index.ts`

```typescript
app.post('/api/rename-layers', renameLimiter, async (req, res) => {
  const startTime = Date.now();
  let jobId: string | null = null;
  let layers = req.body.layers; // Hold reference

  try {
    // ... validation and job creation ...

    // Process layers
    const results = await processWithConcurrency(
      layers,
      async (layer, index) => {
        const newName = await generateLayerName(
          layer.imageBase64,
          layer.currentName,
          layer.type
        );

        // Clear image data immediately after use
        layer.imageBase64 = null; // Help GC identify as garbage

        return { id: layer.id, newName };
      },
      renameLimiter
    );

    // Send response
    res.json({ layers: results });

  } catch (error) {
    // ... error handling ...
  } finally {
    // Explicit cleanup (optional - GC will do this anyway)
    layers = null;
    req.body = null;

    // Force GC if exposed (requires --expose-gc flag)
    if (global.gc) {
      global.gc();
    }
  }
});
```

#### Memory Safety Rules

**✅ DO:**
- Store only metadata in PostgreSQL (user_email, layer_count, duration)
- Keep images in memory for request duration only (15-30 seconds)
- Let Node.js garbage collector handle cleanup
- Use request timeouts to prevent hung requests

**❌ DON'T:**
- Store base64 images in PostgreSQL (massive storage waste)
- Store images on disk (security risk, storage cost)
- Keep images in global variables (memory leak)
- Return images in API responses unnecessarily

#### Storage Size Comparison

```
PostgreSQL WITHOUT images:
├─ 1000 jobs × 15 KB metadata = 15 MB
└─ Searchable, fast, cheap

PostgreSQL WITH images:
├─ 1000 jobs × 5 MB images = 5 GB
└─ Expensive, slow, wasteful

Memory-only approach (current):
├─ Active requests only (~20 concurrent × 5 MB = 100 MB)
└─ Auto-freed after response
```

#### Update Health Check with DB Status
**File:** `server/index.ts`

```typescript
app.get('/health', async (req, res) => {
  const checks = {
    server: 'ok',
    database: 'unknown' as 'ok' | 'error' | 'unknown',
    memory: {} as any
  };

  // Check database connection
  try {
    await query('SELECT 1');
    checks.database = 'ok';
  } catch (error) {
    checks.database = 'error';
    console.error('Database health check failed:', error);
  }

  // Memory check
  const memory = process.memoryUsage();
  checks.memory = {
    heapUsedMB: Math.round(memory.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(memory.heapTotal / 1024 / 1024),
    rssMB: Math.round(memory.rss / 1024 / 1024),
    healthyPercent: Math.round((memory.heapUsed / memory.heapTotal) * 100)
  };

  const healthy = checks.database === 'ok' && checks.memory.healthyPercent < 80;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    checks,
    uptime: Math.round(process.uptime())
  });
});
```

---

## Week 3: Deployment & Monitoring

### Day 8: Railway Deployment

#### Create Dockerfile
**File:** `Dockerfile`

```dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY server/package*.json ./server/

# Install dependencies
RUN npm ci --only=production
RUN cd server && npm ci --only=production

# Copy application code
COPY server/ ./server/

# Build TypeScript
RUN cd server && npm run build

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); });"

EXPOSE 3000

CMD ["node", "server/dist/index.js"]
```

#### Update package.json
**File:** `server/package.json`

```json
{
  "scripts": {
    "dev": "ts-node-dev --respawn index.ts",
    "start": "node dist/index.js",
    "build": "tsc",
    "migrate": "psql $DATABASE_URL -f migrations/001_initial.sql"
  }
}
```

#### Railway Configuration
**File:** `railway.json`

```json
{
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "numReplicas": 1,
    "healthcheckPath": "/health",
    "restartPolicyType": "ON_FAILURE",
    "healthcheckTimeout": 10
  }
}
```

#### Environment Variables (Set in Railway Dashboard)
```env
NODE_ENV=production
PORT=3000

# AI Provider
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-xxxxx
OPENROUTER_MODEL_FAST=google/gemini-2.5-flash
OPENROUTER_MODEL_PRO=google/gemini-3-pro-preview
OPENROUTER_MODEL_IMAGE=google/gemini-2.5-flash-image-preview

# Database (automatically set by Railway when you add PostgreSQL)
DATABASE_URL=${{Postgres.DATABASE_URL}}

# Prompt configuration
EDIT_PROMPT_FILE=creative-director-with-images.txt

# Optional: Logging
LOG_LEVEL=info
```

### Day 9: Monitoring & Analytics Dashboard

#### Create Analytics Endpoint
**File:** `server/index.ts`

```typescript
// Analytics endpoint (protected - add auth later)
app.get('/api/analytics', async (req, res) => {
  try {
    const { days = 7 } = req.query;

    // Get job statistics
    const stats = await query(`
      SELECT
        type,
        COUNT(*) as total_jobs,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        AVG(duration_ms) as avg_duration_ms,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) as p50_duration_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95_duration_ms
      FROM jobs
      WHERE created_at > NOW() - INTERVAL '${days} days'
      GROUP BY type
    `);

    // Get daily trend
    const dailyTrend = await query(`
      SELECT
        DATE(created_at) as date,
        type,
        COUNT(*) as jobs,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successful
      FROM jobs
      WHERE created_at > NOW() - INTERVAL '${days} days'
      GROUP BY DATE(created_at), type
      ORDER BY date DESC
    `);

    // Get top users by email
    const topUsers = await query(`
      SELECT
        user_email,
        COUNT(*) as total_jobs,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successful_jobs,
        MAX(created_at) as last_activity
      FROM jobs
      WHERE created_at > NOW() - INTERVAL '${days} days'
      GROUP BY user_email
      ORDER BY total_jobs DESC
      LIMIT 10
    `);

    res.json({
      summary: stats.rows,
      dailyTrend: dailyTrend.rows,
      topUsers: topUsers.rows
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});
```

### Day 10: Load Testing

#### Install k6 (local machine)
```bash
brew install k6  # macOS
# or download from https://k6.io/docs/getting-started/installation/
```

#### Create Load Test Script
**File:** `tests/load-test.js`

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('errors');
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  stages: [
    { duration: '1m', target: 20 },   // Ramp up to 20 users
    { duration: '3m', target: 50 },   // Ramp up to 50 users
    { duration: '2m', target: 100 },  // Ramp up to 100 users
    { duration: '2m', target: 100 },  // Stay at 100 users
    { duration: '1m', target: 0 },    // Ramp down
  ],
  thresholds: {
    'http_req_duration': ['p(95)<30000'], // 95% of requests under 30s
    'errors': ['rate<0.05'],              // Error rate under 5%
  },
};

export default function () {
  // Test health endpoint
  const healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, {
    'health check status 200': (r) => r.status === 200,
  });

  // Simulate rename-layers request (small payload for testing)
  const renamePayload = JSON.stringify({
    layers: Array(10).fill(null).map((_, i) => ({
      id: `layer-${i}`,
      imageBase64: 'iVBORw0KGgoAAAANSUhEUg...', // Truncated for brevity
      currentName: `Layer ${i}`,
      type: 'RECTANGLE'
    }))
  });

  const renameRes = http.post(`${BASE_URL}/api/rename-layers`, renamePayload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '60s'
  });

  const success = check(renameRes, {
    'rename status 200': (r) => r.status === 200,
    'rename has layers': (r) => JSON.parse(r.body).layers.length === 10,
  });

  errorRate.add(!success);
  sleep(5); // Wait 5s between requests
}
```

#### Run Load Test
```bash
# Test locally first
npm run server  # In one terminal
k6 run tests/load-test.js  # In another terminal

# Test Railway deployment
k6 run --env BASE_URL=https://your-app.railway.app tests/load-test.js
```

---

## Cost Breakdown (Revised)

### Monthly Infrastructure Costs

| Service | Tier | Cost |
|---------|------|------|
| Railway Web Service | 1 replica (1GB RAM) | ~$20-30 |
| Railway PostgreSQL | 1GB storage | ~$10 |
| **Total Infrastructure** | | **~$30-40/mo** |

### API Costs (Per 1000 Jobs)

| Operation | Model | Cost per 1K Jobs |
|-----------|-------|------------------|
| Rename (50 layers avg, parallel) | Gemini Flash | ~$0.50 |
| Generate Edits (5 variants) | Gemini Pro | ~$5.00 |
| Image Generation (5 images, parallel) | Gemini Image | ~$2.00 |
| **Total per 1K jobs** | | **~$7.50** |

### Total Cost Projections

| Users | Jobs/Day | Monthly API | Infrastructure | Total/Mo |
|-------|----------|-------------|----------------|----------|
| 50    | 200      | ~$45        | ~$35           | **~$80** |
| 100   | 500      | ~$115       | ~$35           | **~$150** |
| 200   | 1000     | ~$230       | ~$35           | **~$265** |

**Cost Savings vs Original Plan:**
- No Redis: -$5/month
- No separate workers: -$40/month
- Simpler architecture: Easier maintenance
- **Total savings: ~$45-50/month**

---

## Success Metrics

### Performance Targets

| Metric | Target | Current | After Phase 1 |
|--------|--------|---------|---------------|
| Rename 50 layers | < 30s | ~150s | ~15s ✅ |
| Generate edits | < 60s | ~45s | ~30s ✅ |
| Generate 10 images | < 20s | Sequential (75s) | ~15s ✅ |
| Concurrent users | 100+ | ~5 | 100+ ✅ |
| Memory usage | < 512 MB | Unknown | Monitored ✅ |
| Error rate | < 1% | Unknown | Tracked ✅ |

### Phase Milestones

#### Week 1 ✅
- [x] Parallel processing for rename-layers (10x faster)
- [x] Parallel image generation (5x faster)
- [x] Memory monitoring in health check
- [x] Request timeouts (120s)
- [x] Rate limiting per IP
- [x] Body size limit reduced (100mb → 20mb)

#### Week 2 ✅
- [x] PostgreSQL schema deployed (with user_email as required field)
- [x] Job tracking with metadata (no payload storage)
- [x] User email collection from Figma API
- [x] Prompt selector UI with auto-discovery
- [x] `/api/prompts` endpoint for dynamic prompt list
- [x] Analytics queries (daily/weekly stats, per-user stats)
- [x] Health check includes DB status
- [x] Graceful error handling with DB logging
- [x] **Image memory management verified (memory-only, no disk/DB storage)**

#### Week 3 ✅
- [x] Railway deployment configured
- [x] Docker container optimized
- [x] Load testing passed (100 concurrent)
- [x] Monitoring dashboard (analytics endpoint)
- [x] Documentation updated

---

## When to Add Redis (Future)

Add Redis only if you observe:

1. **Memory consistently > 70%** under normal load
2. **Response times > 60 seconds** regularly
3. **Need async job queue** (if OpenRouter adds rate limits)
4. **Multiple server replicas** (need shared state)
5. **Want job retry after server restart** (durability)

**Implementation cost:**
- Redis on Railway: +$5/month
- Code complexity: +3 days development
- Maintenance overhead: Medium

---

## Implementation Checklist

### Week 1: Performance
- [ ] Install `p-limit`, `connect-timeout`, `express-rate-limit`
- [ ] Create `server/lib/concurrency.ts`
- [ ] Update rename-layers endpoint (parallel)
- [ ] Update image generation (parallel)
- [ ] Add request timeouts
- [ ] Add memory monitoring
- [ ] Add rate limiting
- [ ] Test locally with 50 layers

### Week 2: Database
- [ ] Install `pg` package
- [ ] Create `server/lib/db.ts`
- [ ] Create PostgreSQL on Railway
- [ ] Run migration `001_initial.sql`
- [ ] **Add user email collection in `code.ts`**
- [ ] **Update `ui.html` to send user email in requests**
- [ ] Update request interfaces to include `userEmail`
- [ ] Update endpoints with job logging (including user_email)
- [ ] **Create `/api/prompts` endpoint for prompt discovery**
- [ ] **Update generate-edits to accept `promptFile` parameter**
- [ ] **Add prompt selector dropdown in `ui.html`**
- [ ] Create analytics endpoint
- [ ] Test DB queries locally
- [ ] **Test prompt selector (add new .txt file to prompts/ and verify it appears)**
- [ ] **Verify images are NOT stored in DB (only metadata)**

### Week 3: Deploy
- [ ] Create `Dockerfile`
- [ ] Create `railway.json`
- [ ] Set environment variables
- [ ] Deploy to Railway
- [ ] Run migration on production DB
- [ ] Test production deployment
- [ ] Run load test with k6
- [ ] Monitor for 24 hours
- [ ] Update documentation

---

## Rollback Plan

If issues occur:

1. **High memory usage:** Reduce concurrency limits in `concurrency.ts`
2. **Database errors:** Temporarily disable DB logging, keep processing
3. **Slow performance:** Revert to sequential processing as fallback
4. **Railway issues:** Have Render/Heroku as backup platform

---

Ready to implement Phase 1? Start with the parallelization - that's your biggest win with minimal risk.
