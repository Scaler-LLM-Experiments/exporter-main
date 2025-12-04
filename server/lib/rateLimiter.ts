import rateLimit from 'express-rate-limit';

// RATE LIMITING DISABLED FOR INTERNAL TOOL
// No IP-based restrictions, no user-based restrictions
// All users from same office can use freely

// Dummy limiters that allow unlimited requests (for internal tool use)
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10000, // Effectively unlimited
  message: { error: 'Rate limit (should not hit this)' },
  standardHeaders: false,
  legacyHeaders: false
});

// Heavy operations now allow 100 requests per minute (no IP restriction)
export const heavyLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 heavy operations per minute (increased from 40)
  message: {
    error: 'Too many complex requests',
    message: 'Please wait before generating more variants'
  },
  standardHeaders: false,
  legacyHeaders: false
});

// Rename limiter also set to high limit
export const renameRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10000, // Effectively unlimited
  message: { error: 'Rate limit (should not hit this)' },
  standardHeaders: false,
  legacyHeaders: false
});
