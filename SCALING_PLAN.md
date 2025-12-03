# Production Scaling & Deployment Plan

## Figma Exporter AI Plugin - 100+ Concurrent Users

---

## Executive Summary

This plan outlines the transformation of the Figma Exporter AI plugin from a single-user development setup to a production-ready service capable of handling **100-200 concurrent users**. The current architecture has critical bottlenecks that will cause failures at scale.

| Attribute | Value |
|-----------|-------|
| **Timeline** | 2 weeks (MVP) |
| **Target Platform** | Railway or Render |
| **Persistence** | Redis (job queues) + PostgreSQL (job history) |
| **Target Users** | 100-200 concurrent |

---

## Current Architecture Analysis

### What Works
- Express server with CORS enabled
- Dual provider support (Gemini/OpenRouter)
- Streaming responses for generate-edits
- Modular prompt file loading
- Image generation via OpenRouter

### Critical Bottlenecks

| Issue | Impact at Scale | Severity |
|-------|----------------|----------|
| **Sequential API calls** in rename-layers | 50 layers = 50 serial requests (~2-3 min) | CRITICAL |
| **No request queuing** | Concurrent requests compete for resources | CRITICAL |
| **Memory accumulation** | Large base64 images held in memory per request | HIGH |
| **No rate limiting** | Can exhaust API quotas quickly | HIGH |
| **Single process** | One crash = all users affected | HIGH |
| **No connection pooling** | New connections per request | MEDIUM |
| **No caching** | Duplicate work for similar requests | MEDIUM |
| **No health checks** | Silent failures, no auto-recovery | MEDIUM |

---

## Target Architecture

```
                                    ┌─────────────────┐
                                    │   PostgreSQL    │
                                    │  (Job History)  │
                                    └────────┬────────┘
                                             │
┌──────────┐     ┌─────────────┐    ┌───────┴───────┐    ┌─────────────┐
│  Figma   │────▶│   Railway   │───▶│     Redis     │───▶│   Workers   │
│  Plugin  │◀────│   (API)     │◀───│   (BullMQ)    │◀───│  (1-4 pods) │
└──────────┘     └─────────────┘    └───────────────┘    └─────────────┘
                        │                                       │
                        │                                       │
                        └───────────────┬───────────────────────┘
                                        ▼
                              ┌─────────────────┐
                              │  OpenRouter /   │
                              │    Gemini API   │
                              └─────────────────┘
```

**Key Changes:**
- Async job queue pattern (return job ID, poll for status)
- Separate worker processes for AI processing
- Redis for job queues with BullMQ
- PostgreSQL for job persistence and analytics

---

## Week 1: Essential Scaling Fixes

### Day 1-2: Job Queue Infrastructure

**Files to create:**
- `server/lib/queue.ts` - BullMQ queue setup
- `server/lib/db.ts` - PostgreSQL connection pool

**Dependencies to add:**
```bash
npm install bullmq ioredis pg uuid
npm install -D @types/pg @types/uuid
```

**Queue Configuration:**
```typescript
// server/lib/queue.ts
import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis(process.env.REDIS_URL);

export const renameQueue = new Queue('rename-layers', { connection });
export const generateQueue = new Queue('generate-edits', { connection });
export const imageQueue = new Queue('generate-images', { connection });

export const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: 100,
  removeOnFail: 50
};
```

### Day 3-4: Parallel Processing for Rename Layers

**Current Problem (Sequential):**
```typescript
// 50 layers = 50 serial API calls (~150s)
for (const layer of layers) {
  const newName = await generateLayerName(...);
}
```

**Solution (Parallel Batches):**
```typescript
// 50 layers = 5 batches of 10 (~30s)
const BATCH_SIZE = 10;
const MAX_CONCURRENT = 5;

async function processLayersInParallel(layers: Layer[]): Promise<RenamedLayer[]> {
  const results: RenamedLayer[] = [];

  for (let i = 0; i < layers.length; i += BATCH_SIZE * MAX_CONCURRENT) {
    const megaBatch = layers.slice(i, i + BATCH_SIZE * MAX_CONCURRENT);
    const batches = chunk(megaBatch, BATCH_SIZE);

    const batchResults = await Promise.all(
      batches.map(batch => processBatch(batch))
    );

    results.push(...batchResults.flat());
  }

  return results;
}
```

**Performance Impact:** 50 layers drops from ~150s to ~30s (5x improvement)

### Day 5-6: Rate Limiting & Memory Optimization

**File to create:** `server/lib/rateLimiter.ts`

```typescript
import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';

export const apiLimiter = rateLimit({
  store: new RedisStore({ sendCommand: (...args) => redis.sendCommand(args) }),
  windowMs: 60 * 1000,
  max: 10,  // 10 requests per minute per IP
  message: { error: 'Too many requests, please wait' }
});

export const heavyLimiter = rateLimit({
  store: new RedisStore({ sendCommand: (...args) => redis.sendCommand(args) }),
  windowMs: 60 * 1000,
  max: 3,  // 3 generate-edits per minute
  message: { error: 'Please wait before generating more variants' }
});
```

**Memory Fix - Store payloads in Redis:**
```typescript
// Instead of holding base64 in memory
await redis.setex(`job:${jobId}:payload`, 300, JSON.stringify(req.body));
await generateQueue.add('generate', { jobId }, defaultJobOptions);
```

### Day 6-7: Async API Endpoints

**New Pattern:**
```typescript
// POST /api/generate-edits - Queue job and return immediately
app.post('/api/generate-edits', heavyLimiter, async (req, res) => {
  const jobId = uuidv4();

  await db.query(
    'INSERT INTO jobs (id, type, status) VALUES ($1, $2, $3)',
    [jobId, 'generate-edits', 'queued']
  );

  await generateQueue.add('generate', { jobId, ...req.body });

  res.json({ jobId, status: 'queued', pollUrl: `/api/jobs/${jobId}` });
});

// GET /api/jobs/:id - Poll for status
app.get('/api/jobs/:id', async (req, res) => {
  const job = await db.query('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
  res.json(job.rows[0]);
});
```

---

## Week 2: Production Deployment

### Day 8-9: Database Setup

**PostgreSQL Schema:**
```sql
CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'queued',
  payload JSONB,
  result JSONB,
  error TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP
);

CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_created ON jobs(created_at DESC);
```

### Day 9-10: Docker Configuration

**Files to create:**
- `Dockerfile`
- `docker-compose.yml`

**Dockerfile:**
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY server/ ./server/
RUN npm run build:server

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

EXPOSE 3000
CMD ["node", "server/dist/index.js"]
```

**docker-compose.yml:**
```yaml
version: '3.8'

services:
  api:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - REDIS_URL=redis://redis:6379
      - DATABASE_URL=postgres://user:pass@postgres:5432/figma_exporter
      - AI_PROVIDER=openrouter
      - OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
    depends_on:
      - redis
      - postgres

  worker:
    build: .
    command: node server/dist/worker.js
    environment:
      - REDIS_URL=redis://redis:6379
      - DATABASE_URL=postgres://user:pass@postgres:5432/figma_exporter
      - AI_PROVIDER=openrouter
      - OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
    depends_on:
      - redis
      - postgres
    deploy:
      replicas: 2

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data

  postgres:
    image: postgres:15-alpine
    environment:
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=pass
      - POSTGRES_DB=figma_exporter
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  redis_data:
  postgres_data:
```

### Day 10-11: Railway Deployment

**File to create:** `railway.json`
```json
{
  "build": { "builder": "DOCKERFILE" },
  "deploy": {
    "numReplicas": 2,
    "healthcheckPath": "/health",
    "restartPolicyType": "ON_FAILURE"
  }
}
```

**Environment Variables (Railway Dashboard):**
```
NODE_ENV=production
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-xxx
REDIS_URL=${{Redis.REDIS_URL}}
DATABASE_URL=${{Postgres.DATABASE_URL}}
EDIT_PROMPT_FILE=creative-director-with-images.txt
```

### Day 11-12: Monitoring & Health Checks

**Enhanced Health Check:**
```typescript
app.get('/health', async (req, res) => {
  const checks = { server: 'ok', redis: 'unknown', postgres: 'unknown' };

  try { await redis.ping(); checks.redis = 'ok'; } catch { checks.redis = 'error'; }
  try { await db.query('SELECT 1'); checks.postgres = 'ok'; } catch { checks.postgres = 'error'; }

  const healthy = checks.redis === 'ok' && checks.postgres === 'ok';
  res.status(healthy ? 200 : 503).json(checks);
});
```

**Structured Logging with Pino:**
```typescript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development'
    ? { target: 'pino-pretty' }
    : undefined
});

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration: Date.now() - start
    });
  });
  next();
});
```

### Day 12-13: Plugin UI Updates

**Polling for Job Status:**
```javascript
async function pollJobStatus(jobId) {
  const maxAttempts = 60; // 5 minutes max
  let attempts = 0;

  while (attempts < maxAttempts) {
    const response = await fetch(`${BACKEND_URL}/api/jobs/${jobId}`);
    const job = await response.json();

    if (job.status === 'completed') return job.result;
    if (job.status === 'failed') throw new Error(job.error);

    updateProgress(`Processing... (${job.status})`);
    await new Promise(r => setTimeout(r, 5000));
    attempts++;
  }
  throw new Error('Job timed out');
}
```

### Day 13-14: Load Testing

**k6 Test Script:**
```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 50 },
    { duration: '3m', target: 100 },
    { duration: '1m', target: 0 },
  ],
};

export default function () {
  const health = http.get('https://your-app.railway.app/health');
  check(health, { 'health ok': (r) => r.status === 200 });
  sleep(1);
}
```

---

## Infrastructure Checklist

### Redis Setup
- [ ] Create Redis instance on Railway
- [ ] Configure connection pooling
- [ ] Set key expiration policies (TTL: 1 hour)
- [ ] Enable persistence (AOF)
- [ ] Configure memory limit with eviction

### PostgreSQL Setup
- [ ] Create PostgreSQL instance
- [ ] Run migration scripts
- [ ] Set up connection pooling (PgBouncer)
- [ ] Configure automated backups

### Application Setup
- [ ] Configure environment variables
- [ ] Set up Docker build pipeline
- [ ] Configure auto-scaling (2-4 replicas)
- [ ] Set up health check endpoints
- [ ] Configure graceful shutdown

### Security
- [ ] Enable HTTPS only
- [ ] Configure CORS for Figma domain
- [ ] Rotate API keys
- [ ] Add request validation

### Monitoring
- [ ] Set up structured logging (Pino)
- [ ] Configure Railway metrics dashboard
- [ ] Set up alerts for error rate > 5%
- [ ] Set up alerts for response time > 30s
- [ ] Set up uptime monitoring

---

## Cost Estimates

### Infrastructure (Monthly)

| Service | Tier | Cost |
|---------|------|------|
| Railway API (2 replicas) | Pro | ~$20-40 |
| Railway Workers (2 replicas) | Pro | ~$20-40 |
| Railway Redis | 100MB | ~$5 |
| Railway PostgreSQL | 1GB | ~$10 |
| **Total Infrastructure** | | **~$55-95/mo** |

### API Costs (Per 1000 Jobs)

| Operation | Model | Cost per 1K |
|-----------|-------|-------------|
| Rename (50 layers avg) | Gemini Flash | ~$0.50 |
| Generate Edits | Gemini Pro | ~$5.00 |
| Image Generation (5 imgs) | Gemini Flash Image | ~$2.00 |
| **Total per 1K jobs** | | **~$7.50** |

### Scaling Projection

| Users | Jobs/Day | Monthly API | Total/Mo |
|-------|----------|-------------|----------|
| 50 | 200 | ~$45 | ~$140 |
| 100 | 500 | ~$115 | ~$210 |
| 200 | 1000 | ~$230 | ~$325 |

---

## Success Criteria

### Performance Targets

| Metric | Target | Current |
|--------|--------|---------|
| Concurrent users | 100-200 | ~5 |
| Rename layers (50) | < 45s | ~150s |
| Generate edits | < 60s | ~45s |
| 99th percentile latency | < 90s | Unknown |
| Error rate | < 1% | Unknown |
| Uptime | 99.5% | N/A |

### Week 1 Milestones
- [ ] BullMQ queues operational
- [ ] Parallel rename processing (5x faster)
- [ ] Rate limiting in place
- [ ] Memory usage stable under load

### Week 2 Milestones
- [ ] PostgreSQL schema deployed
- [ ] Docker containers building
- [ ] Railway deployment live
- [ ] Monitoring dashboards active
- [ ] Load test passed (100 concurrent)
- [ ] Plugin UI updated for async jobs

---

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `server/lib/queue.ts` | Create | BullMQ queue setup |
| `server/lib/rateLimiter.ts` | Create | Rate limiting |
| `server/lib/db.ts` | Create | PostgreSQL connection |
| `server/workers/rename.worker.ts` | Create | Rename job processor |
| `server/workers/generate.worker.ts` | Create | Generate job processor |
| `server/index.ts` | Modify | Add async endpoints |
| `Dockerfile` | Create | Container config |
| `docker-compose.yml` | Create | Local dev env |
| `railway.json` | Create | Deployment config |
| `ui.html` | Modify | Add job polling |
| `migrations/001_initial.sql` | Create | DB schema |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| API rate limits exceeded | Queue-based processing, exponential backoff, circuit breaker |
| Memory exhaustion | Redis payload storage, streaming, memory limits |
| Single point of failure | Multiple replicas, health checks, auto-restart |
| Cold starts | Minimum 1 replica always running |

---

## Implementation Phases

1. **Phase 1** (Days 1-4): Queue infrastructure + parallel processing
2. **Phase 2** (Days 5-7): Rate limiting + memory optimization
3. **Phase 3** (Days 8-10): Database + Docker setup
4. **Phase 4** (Days 11-14): Deploy + monitor + load test

---

Ready to begin implementation upon approval.
