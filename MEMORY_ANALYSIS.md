# Memory Analysis

## Current Memory Usage

### Per Request Memory Footprint

#### Rename Layers Request
```
Request body stored in memory:
├─ Express body parser: req.body object
├─ 50 layers × ~100KB base64 image = ~5 MB
├─ Layer metadata (names, types, etc.) = ~50 KB
└─ Total per request: ~5 MB

Duration in memory:
├─ Sequential processing: ~150 seconds (until response sent)
├─ With parallelization: ~15 seconds (until response sent)
└─ Memory cleared: When response.send() completes (Node.js GC)
```

#### Generate Edits Request
```
Request body stored in memory:
├─ Frame metadata = ~100 KB
├─ Frame image (1x scale) = ~500 KB - 2 MB
├─ Layer metadata array = ~50-200 KB
└─ Total per request: ~1-3 MB

Duration in memory:
├─ Current processing: ~45 seconds
├─ With image generation: ~60-90 seconds
└─ Memory cleared: When streaming response completes
```

#### Generate Images (within edits)
```
Generated images stored in memory:
├─ 5 variants × 2 images each = 10 images
├─ Each generated image: ~500 KB - 2 MB base64
├─ Total: ~5-20 MB held during processing
└─ Duration: Until response sent to client
```

### Concurrent User Impact

#### Without Parallelization (Current)
```
10 concurrent users:
├─ Each running rename (sequential)
├─ 10 users × 5 MB = 50 MB in memory
└─ Risk: LOW (sequential means requests complete fast)

100 concurrent users:
├─ 100 users × 5 MB = 500 MB in memory
└─ Risk: MEDIUM (but unlikely all hit at exact same second)
```

#### With Parallelization (Proposed)
```
10 concurrent users:
├─ Each running rename (10 parallel API calls)
├─ 10 users × 5 MB = 50 MB
├─ + 10 users × 10 concurrent calls × overhead = +100 MB
└─ Total: ~150 MB
└─ Risk: LOW

100 concurrent users (realistic peak: ~20 active):
├─ 20 active users × 5 MB = 100 MB
├─ + parallelization overhead = +200 MB
└─ Total: ~300 MB
└─ Risk: MEDIUM (manageable on 512 MB - 1 GB Railway instance)
```

### Memory Leak Risks

#### ❌ RISK 1: No Request Timeout
```typescript
// Current code - no timeout!
app.post('/api/rename-layers', async (req, res) => {
  const { layers } = req.body; // 5 MB held in memory

  for (let i = 0; i < layers.length; i++) {
    const newName = await generateLayerName(...); // What if this hangs?
  }

  res.json({ layers: results }); // Memory only freed here
});
```

**Problem:** If AI API hangs, request body stays in memory forever.

#### ❌ RISK 2: Large Body Size Limit
```typescript
app.use(express.json({ limit: '100mb' })); // ⚠️ Very large!
```

**Problem:** Attacker could send 100 MB request × 10 concurrent = 1 GB exhausted.

#### ❌ RISK 3: No Cleanup on Error
```typescript
try {
  const results = await processLayers(layers); // layers still in memory
  res.json({ layers: results });
} catch (error) {
  res.status(500).json({ error: error.message });
  // layers object still in memory until GC runs!
}
```

**Problem:** Failed requests accumulate in memory until garbage collection.

#### ✅ NO RISK: No Global State
```typescript
// Good: No global caches or stores
// All data is request-scoped and GC'd after response
```

## Memory Spike Scenarios

### Scenario 1: Flash Crowd (100 users hit at once)
```
100 concurrent rename requests:
├─ 100 × 5 MB request bodies = 500 MB
├─ + parallelization overhead = +500 MB
└─ Total: ~1 GB peak memory

Railway instance types:
├─ 512 MB: ❌ Will crash
├─ 1 GB: ⚠️  At limit (risky)
├─ 2 GB: ✅ Safe
```

### Scenario 2: Image Generation Spike
```
20 concurrent generate-edits with images:
├─ 20 × 3 MB request = 60 MB
├─ 20 × 15 MB generated images = 300 MB
├─ Streaming buffers = +100 MB
└─ Total: ~460 MB peak

Railway 512 MB: ⚠️ Tight but possible
Railway 1 GB: ✅ Safe
```

### Scenario 3: Slow AI API Response
```
If AI API responds in 30s instead of 3s:
├─ 10x more concurrent requests in memory
├─ 10 active → 100 active requests
└─ Memory: 50 MB → 500 MB spike

Mitigation: Request timeouts
```

## Garbage Collection Behavior

### Node.js Memory Management
```javascript
Request lifecycle:
1. Request arrives → req.body allocated (~5 MB)
2. Processing happens → req.body still in heap
3. Response sent → req.body becomes eligible for GC
4. Next GC cycle → Memory actually freed (not immediate!)

GC triggers:
├─ Automatic: When heap reaches threshold
├─ Manual: process.memoryUsage() → gc() (if --expose-gc flag)
└─ Typical delay: 100ms - 5s after response
```

### Memory Accumulation Example
```
Timeline with 10 req/sec:
00:00 - Request 1 arrives (5 MB allocated)
00:01 - Request 2 arrives (10 MB total)
00:02 - Request 3 arrives (15 MB total)
...
00:15 - Request 1 finishes (5 MB eligible for GC, but not freed yet)
00:16 - GC runs (5 MB actually freed)

Without GC optimization:
├─ Memory grows linearly until GC threshold
└─ Can reach 200-300 MB before GC kicks in
```

## Redis Role in Memory Management

### What Redis Solves

#### 1. Payload Offloading
```typescript
// Without Redis (current):
const { layers } = req.body; // 5 MB in app memory
await processLayers(layers);
res.json(results);

// With Redis:
const jobId = uuid();
await redis.set(`job:${jobId}:payload`, JSON.stringify(req.body), 'EX', 300);
await queue.add({ jobId }); // Only jobId in queue (~100 bytes)
res.json({ jobId }); // Response sent immediately, memory freed

// Worker process:
const payload = await redis.get(`job:${jobId}:payload`); // Fetch when ready
await processLayers(payload.layers);
await redis.set(`job:${jobId}:result`, JSON.stringify(results), 'EX', 300);
```

**Benefit:** App memory freed immediately, payload stored in Redis.

#### 2. Memory Isolation
```
Without Redis:
├─ API server holds all request data
└─ Memory spike affects all users

With Redis:
├─ API server: ~50 MB (just job metadata)
├─ Redis: Holds payloads (5 MB × 100 jobs = 500 MB)
└─ Workers: Process one job at a time (~5-10 MB each)
```

### When You DON'T Need Redis for Memory

#### Synchronous Processing (Current + Parallelization)
```typescript
app.post('/api/rename-layers', async (req, res) => {
  const { layers } = req.body; // Held in memory
  const results = await processLayersParallel(layers); // Process immediately
  res.json({ layers: results }); // Memory freed after response
  // No Redis needed - memory lifetime is request duration
});
```

**Key:** Memory is freed as soon as response is sent (15-30 seconds).

#### When You DO Need Redis

```typescript
// Async job pattern (slow processing or rate limits):
app.post('/api/rename-layers', async (req, res) => {
  const jobId = uuid();
  await redis.set(`job:${jobId}`, req.body); // Offload to Redis
  res.json({ jobId }); // Response sent immediately
  // App memory freed now, not after processing completes
});
```

**Key:** Memory is freed immediately, not after processing (30+ seconds).

## Decision Matrix: Redis vs No Redis

| Factor | No Redis | With Redis |
|--------|----------|------------|
| **Request-response time** | 15-30s | Immediate (< 100ms) |
| **App memory usage** | 100-500 MB peak | 50-100 MB stable |
| **Processing pattern** | Synchronous | Async (queue) |
| **Memory freed** | After response | Immediately |
| **Code complexity** | Low | High |
| **Infrastructure cost** | $0 | +$5/mo |
| **Best for** | Fast processing, no rate limits | Slow processing, rate limits |

## Recommendations

### Phase 1: No Redis + Memory Optimizations

#### 1. Add Request Timeouts
```typescript
import timeout from 'connect-timeout';

app.use(timeout('120s')); // 2 minute timeout
app.use((req, res, next) => {
  if (!req.timedout) next();
});

app.post('/api/rename-layers', async (req, res) => {
  // Request will abort after 120s
  // Memory freed even if AI API hangs
});
```

#### 2. Reduce Body Size Limit
```typescript
app.use(express.json({ limit: '20mb' })); // Was 100mb
// 50 layers × 100 KB × 4x safety = 20 MB is plenty
```

#### 3. Add Memory Monitoring
```typescript
app.get('/health', (req, res) => {
  const memory = process.memoryUsage();
  res.json({
    status: 'ok',
    memory: {
      heapUsed: `${Math.round(memory.heapUsed / 1024 / 1024)} MB`,
      heapTotal: `${Math.round(memory.heapTotal / 1024 / 1024)} MB`,
      rss: `${Math.round(memory.rss / 1024 / 1024)} MB`
    }
  });
});
```

#### 4. Explicit Cleanup on Errors
```typescript
app.post('/api/rename-layers', async (req, res) => {
  let layers = req.body.layers;

  try {
    const results = await processLayersParallel(layers);
    res.json({ layers: results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    layers = null; // Help GC identify as garbage
    if (global.gc) global.gc(); // Force GC if available
  }
});
```

### Phase 2: Add Redis If Needed

**Trigger conditions:**
- ✅ Memory usage > 70% consistently
- ✅ Response times > 60 seconds
- ✅ Need to support 200+ concurrent users
- ✅ Memory-related crashes occur

**Implementation:**
```typescript
import Redis from 'ioredis';
const redis = new Redis(process.env.REDIS_URL);

// Store large payloads in Redis
app.post('/api/rename-layers', async (req, res) => {
  const jobId = uuid();

  // Offload payload to Redis (expires in 5 minutes)
  await redis.setex(
    `job:${jobId}:payload`,
    300,
    JSON.stringify(req.body)
  );

  // Still process synchronously, but payload is in Redis
  const payload = JSON.parse(await redis.get(`job:${jobId}:payload`));
  const results = await processLayersParallel(payload.layers);

  // Store result
  await redis.setex(
    `job:${jobId}:result`,
    300,
    JSON.stringify(results)
  );

  res.json({ layers: results });
});
```

## With PostgreSQL: Memory Still Not a Problem

### PostgreSQL Stores Metadata, Not Payloads
```typescript
// Good approach: Don't store images in PostgreSQL
await db.query(`
  INSERT INTO jobs (id, type, layer_count, status)
  VALUES ($1, $2, $3, $4)
`, [jobId, 'rename-layers', layers.length, 'processing']);

// Process in memory (same as now)
const results = await processLayersParallel(layers);

// Store results metadata (not full images)
await db.query(`
  UPDATE jobs
  SET status = 'completed', completed_at = NOW()
  WHERE id = $1
`, [jobId]);
```

**Memory usage:** Same as current (no increase from adding PostgreSQL).

## Final Recommendation

### ✅ Add PostgreSQL (for analytics, no memory impact)
### ⚠️ Skip Redis initially (monitor memory first)
### ✅ Add memory optimizations (timeouts, limits, monitoring)

**Redis becomes necessary only if:**
1. You implement async job queue pattern
2. Memory consistently > 70% under load
3. You need to scale to multiple server instances (shared job state)
