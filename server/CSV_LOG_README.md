# CSV Upload Log

## Overview

Every ZIP file upload is automatically logged to `uploads.csv` in the server directory.

## Location

```
server/uploads.csv
```

The file is created automatically on first upload. If deleted, it will be recreated with headers.

## CSV Format

| Column | Description | Example |
|--------|-------------|---------|
| **Timestamp** | ISO 8601 timestamp | `2025-12-04T17:30:45.123Z` |
| **Frame Name** | Original frame name | `00001` |
| **File Name** | ZIP filename | `00001.zip` |
| **S3 URL** | Full S3 URL | `https://bucket.s3.region.amazonaws.com/00001.zip` |
| **File Size (Bytes)** | Size in bytes | `2458624` |
| **File Size (MB)** | Size in megabytes | `2.34` |
| **Variant Count** | Number of variants | `10` |
| **User Email** | User's email | `user@company.com` |
| **IP Address** | Client IP | `192.168.1.100` |
| **Duration (ms)** | Upload time in ms | `1250` |
| **Status** | `success` or `failed` | `success` |
| **Error Message** | Error details (if failed) | `Network timeout` |

## Example CSV Content

```csv
Timestamp,Frame Name,File Name,S3 URL,File Size (Bytes),File Size (MB),Variant Count,User Email,IP Address,Duration (ms),Status,Error Message
2025-12-04T17:30:45.123Z,00001,00001.zip,https://bucket.s3.us-east-1.amazonaws.com/00001.zip,2458624,2.34,10,user@company.com,192.168.1.100,1250,success,
2025-12-04T17:31:12.456Z,00002,00002.zip,https://bucket.s3.us-east-1.amazonaws.com/00002.zip,3145728,3.00,10,user@company.com,192.168.1.100,1580,success,
2025-12-04T17:32:05.789Z,00003,00003.zip,,0,0.00,0,user@company.com,192.168.1.100,450,failed,Network timeout
```

## Features

### Automatic Creation
- CSV file created automatically on first upload
- Headers added automatically
- No manual setup required

### Append-Only
- Each upload appends a new row
- Never overwrites existing data
- Safe for concurrent uploads (per-machine)

### CSV Escaping
- Properly handles commas in values
- Escapes quotes correctly
- Safe for Excel/Google Sheets import

### Error Logging
- Failed uploads also logged
- Error messages included
- Helps with troubleshooting

## Use Cases

### Track Upload History
```bash
# View recent uploads
tail -20 server/uploads.csv

# Count total uploads
wc -l server/uploads.csv
```

### Analysis in Excel
1. Open `uploads.csv` in Excel or Google Sheets
2. Use filters to analyze:
   - Total uploads per day
   - Average file sizes
   - Failed uploads
   - Processing times

### Generate Reports
```bash
# Count successful uploads
grep ",success," server/uploads.csv | wc -l

# Sum total data uploaded (requires awk/python)
awk -F',' 'NR>1 {sum+=$5} END {print sum/1024/1024 " MB"}' server/uploads.csv
```

### Monitor Failures
```bash
# Show all failed uploads
grep ",failed," server/uploads.csv
```

## Backup Recommendations

### Daily Backup
```bash
# Windows (PowerShell)
Copy-Item server\uploads.csv "backups\uploads_$(Get-Date -Format 'yyyy-MM-dd').csv"

# Linux/Mac
cp server/uploads.csv backups/uploads_$(date +%Y-%m-%d).csv
```

### Archive Old Data
After the CSV gets large (>10,000 rows), consider archiving:

```bash
# Move to archive folder
mv server/uploads.csv archive/uploads_2025.csv

# Server will create new file automatically
```

## File Size Management

### Rotation (Optional)

If the CSV gets too large, you can rotate it:

```bash
# Rename current log
mv server/uploads.csv server/uploads_archive_2025-12-04.csv

# Server creates new file on next upload
```

### Expected Growth

- **Per upload:** ~200 bytes
- **1000 uploads:** ~200 KB
- **10,000 uploads:** ~2 MB
- **100,000 uploads:** ~20 MB

With 196GB RAM machines, file size is negligible.

## Integration with Other Tools

### Import to Database (Optional)

```sql
-- PostgreSQL example
COPY uploads FROM '/path/to/uploads.csv'
WITH (FORMAT CSV, HEADER true);
```

### Python Analysis

```python
import pandas as pd

# Load CSV
df = pd.read_csv('server/uploads.csv')

# Calculate statistics
print(f"Total uploads: {len(df)}")
print(f"Success rate: {(df['Status'] == 'success').mean() * 100:.1f}%")
print(f"Total data uploaded: {df['File Size (MB)'].sum():.2f} MB")
print(f"Average file size: {df['File Size (MB)'].mean():.2f} MB")
```

## Notes

- CSV logging is independent of database tracking
- Works even if PostgreSQL is not configured
- Logging failures don't affect upload process
- CSV file is in server directory (not uploaded to S3)

## Troubleshooting

### CSV File Not Created
- Check server has write permissions in server directory
- Check server console for CSV Logger errors

### Missing Data
- CSV only logs S3 uploads (not local exports)
- Check that S3_BUCKET_NAME is configured

### Corrupted CSV
- CSV uses proper escaping, should not corrupt
- If issues occur, delete file - it will recreate

## Security

### Sensitive Data
CSV contains:
- ✅ User emails (if provided)
- ✅ IP addresses (localhost for local setup)
- ❌ No API keys or passwords
- ❌ No actual file contents

### Access Control
- File is local to server machine
- Not exposed via HTTP endpoints
- Protected by Windows file permissions
