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

// Heavy operation rate limit (generate-edits, upload-to-s3)
export const heavyLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 40, // 40 heavy operations per minute per IP (generous limit for bulk processing)
  message: {
    error: 'Too many complex requests',
    message: 'Please wait before generating more variants'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Rename layers rate limit (generous)
export const renameRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 rename requests per minute per IP (supports large batches)
  message: {
    error: 'Too many rename requests',
    message: 'Please wait before renaming more layers'
  },
  standardHeaders: true,
  legacyHeaders: false
});
