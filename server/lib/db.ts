import { Pool } from 'pg';

// Create connection pool (will be null if DATABASE_URL not set)
export const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // Maximum number of connections in the pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
}) : null;

// Test connection on startup
if (pool) {
  pool.on('connect', () => {
    console.log('PostgreSQL connected');
  });

  pool.on('error', (err) => {
    console.error('Unexpected database error:', err);
  });
}

// Helper function to execute queries
export async function query(text: string, params?: any[]) {
  if (!pool) {
    console.warn('Database not configured - skipping query');
    return { rows: [], rowCount: 0 };
  }

  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log('Executed query', { duration, rows: res.rowCount });
    return res;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
}

// Graceful shutdown
export async function closePool() {
  if (pool) {
    await pool.end();
    console.log('PostgreSQL pool closed');
  }
}
