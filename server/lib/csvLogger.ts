import fs from 'fs';
import path from 'path';

/**
 * CSV Logger for tracking ZIP uploads
 * Creates/appends to uploads.csv in the server directory
 */

interface UploadRecord {
  timestamp: string;
  frameName: string;
  fileName: string;
  s3Url?: string;
  fileSizeBytes: number;
  fileSizeMB: string;
  variantCount: number;
  userEmail: string;
  ipAddress: string;
  durationMs: number;
  status: 'success' | 'failed';
  errorMessage?: string;
}

const CSV_FILE_PATH = path.join(__dirname, '..', 'uploads.csv');

// CSV Headers
const CSV_HEADERS = [
  'Timestamp',
  'Frame Name',
  'File Name',
  'S3 URL',
  'File Size (Bytes)',
  'File Size (MB)',
  'Variant Count',
  'User Email',
  'IP Address',
  'Duration (ms)',
  'Status',
  'Error Message'
].join(',');

/**
 * Initialize CSV file with headers if it doesn't exist
 */
function initializeCsvFile(): void {
  if (!fs.existsSync(CSV_FILE_PATH)) {
    fs.writeFileSync(CSV_FILE_PATH, CSV_HEADERS + '\n', 'utf8');
    console.log(`[CSV Logger] Created new CSV file: ${CSV_FILE_PATH}`);
  }
}

/**
 * Escape CSV value (handle commas, quotes, newlines)
 */
function escapeCsvValue(value: any): string {
  if (value === null || value === undefined) {
    return '';
  }

  const str = String(value);

  // If value contains comma, quote, or newline, wrap in quotes and escape quotes
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

/**
 * Log a ZIP upload record to CSV
 */
export function logUploadToCSV(record: UploadRecord): void {
  try {
    // Initialize CSV file if needed
    initializeCsvFile();

    // Format file size in MB
    const fileSizeMB = (record.fileSizeBytes / (1024 * 1024)).toFixed(2);

    // Create CSV row
    const row = [
      escapeCsvValue(record.timestamp),
      escapeCsvValue(record.frameName),
      escapeCsvValue(record.fileName),
      escapeCsvValue(record.s3Url || ''),
      escapeCsvValue(record.fileSizeBytes),
      escapeCsvValue(fileSizeMB),
      escapeCsvValue(record.variantCount),
      escapeCsvValue(record.userEmail),
      escapeCsvValue(record.ipAddress),
      escapeCsvValue(record.durationMs),
      escapeCsvValue(record.status),
      escapeCsvValue(record.errorMessage || '')
    ].join(',');

    // Append to CSV file
    fs.appendFileSync(CSV_FILE_PATH, row + '\n', 'utf8');

    console.log(`[CSV Logger] Logged upload: ${record.frameName} (${record.status})`);
  } catch (error) {
    console.error('[CSV Logger] Failed to write to CSV:', error);
    // Don't throw - CSV logging should not break the upload process
  }
}

/**
 * Get the CSV file path (for reference)
 */
export function getCsvFilePath(): string {
  return CSV_FILE_PATH;
}
