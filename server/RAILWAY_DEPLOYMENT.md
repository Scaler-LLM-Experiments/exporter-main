# Railway Deployment Guide

Complete guide for deploying the Figma Exporter AI backend to Railway.

## Prerequisites

- Railway account (https://railway.app)
- GitHub repository with your code
- OpenRouter or Gemini API key

## Step 1: Prepare Your Repository

1. **Ensure all files are committed:**
   ```bash
   cd server
   git add .
   git commit -m "Prepare for Railway deployment"
   git push
   ```

2. **Important files for deployment:**
   - ✅ `package.json` (has "build" and "start" scripts)
   - ✅ `railway.json` (Railway configuration)
   - ✅ `nixpacks.toml` (Build configuration)
   - ✅ `.env.example` (Template for environment variables)
   - ✅ `tsconfig.json` (TypeScript configuration)
   - ✅ `migrations/001_initial.sql` (Database schema)

## Step 2: Deploy to Railway

### Option A: Deploy from GitHub (Recommended)

1. **Go to Railway dashboard:**
   - Visit https://railway.app
   - Click "New Project"

2. **Select deployment source:**
   - Choose "Deploy from GitHub repo"
   - Select your repository
   - Railway will automatically detect it's a Node.js project

3. **Configure root directory:**
   - Set **Root Directory** to `server`
   - This tells Railway to deploy only the server folder

### Option B: Deploy with Railway CLI

1. **Install Railway CLI:**
   ```bash
   npm install -g @railway/cli
   ```

2. **Login and initialize:**
   ```bash
   railway login
   cd server
   railway init
   ```

3. **Deploy:**
   ```bash
   railway up
   ```

## Step 3: Add PostgreSQL Database

1. **In your Railway project:**
   - Click "+ New" → "Database" → "Add PostgreSQL"
   - Railway automatically creates a database and adds `DATABASE_URL` to your environment

2. **Run database migration:**

   **Option A: Using Railway CLI:**
   ```bash
   railway run psql $DATABASE_URL -f migrations/001_initial.sql
   ```

   **Option B: Using Railway Dashboard:**
   - Go to your PostgreSQL service
   - Click "Data" tab → "Query"
   - Copy/paste contents of `migrations/001_initial.sql`
   - Execute

## Step 4: Configure Environment Variables

In Railway dashboard → Your service → "Variables" tab, add:

### Required Variables

```bash
# AI Provider (choose one)
AI_PROVIDER=openrouter

# OpenRouter (if using)
OPENROUTER_API_KEY=sk-or-v1-your-key-here
OPENROUTER_MODEL_FAST=google/gemini-2.5-flash
OPENROUTER_MODEL_PRO=google/gemini-3-pro-preview
OPENROUTER_MODEL_IMAGE=google/gemini-2.5-flash-image-preview

# OR Gemini (if using)
GEMINI_API_KEY=AIzaSy...your-key-here

# Prompt configuration
EDIT_PROMPT_FILE=creative-director-with-images.txt

# Node environment
NODE_ENV=production
```

### Auto-configured Variables

These are automatically set by Railway:
- ✅ `DATABASE_URL` - PostgreSQL connection string
- ✅ `PORT` - Port number (Railway assigns this)
- ✅ `RAILWAY_ENVIRONMENT` - Environment name

## Step 5: Get Your Deployment URL

1. **After deployment completes:**
   - Go to "Settings" tab in Railway
   - Find "Domains" section
   - Copy the Railway-provided domain (e.g., `your-app.up.railway.app`)

2. **Your backend is now live at:**
   ```
   https://your-app.up.railway.app
   ```

## Step 6: Connect Figma Plugin to Railway

### A. Update UI Backend URL

1. **Edit `ui.html` (line ~509):**
   ```javascript
   // Change from:
   const BACKEND_URL = 'http://localhost:3000';

   // To your Railway URL:
   const BACKEND_URL = 'https://your-app.up.railway.app';
   ```

2. **Rebuild the plugin:**
   ```bash
   cd .. # Go to root directory
   npm run build
   ```

### B. Update Figma Plugin Manifest

1. **Edit `manifest.json`:**
   ```json
   {
     "networkAccess": {
       "allowedDomains": [
         "https://cdnjs.cloudflare.com",
         "https://fonts.googleapis.com",
         "https://fonts.gstatic.com",
         "https://your-app.up.railway.app"
       ],
       "devAllowedDomains": [
         "http://localhost:3000"
       ]
     }
   }
   ```

2. **Rebuild again:**
   ```bash
   npm run build
   ```

### C. Test in Figma

1. **Reload plugin in Figma:**
   - Right-click plugin → "Delete"
   - Import plugin again (Plugins → Development → Import plugin from manifest)

2. **Test all features:**
   - ✅ AI Rename Layers
   - ✅ Generate Edits with different prompts
   - ✅ AI Image Generation
   - Check browser console for any errors

## Step 7: Verify Deployment

### Test API Endpoints

```bash
# Health check
curl https://your-app.up.railway.app/health

# Get available prompts
curl https://your-app.up.railway.app/api/prompts
```

### Check Database Connection

In Railway dashboard → PostgreSQL → Data tab:
```sql
-- View recent jobs
SELECT id, type, status, user_email, duration_ms, created_at
FROM jobs
ORDER BY created_at DESC
LIMIT 10;

-- Check table structure
\d jobs
```

## Monitoring & Logs

### View Logs
- Railway Dashboard → Your service → "Deployments" tab → Click latest deployment
- Real-time logs show all console output

### Key Metrics to Monitor
- Memory usage (should stay under 400MB)
- Request duration (rename: ~3-5s, generate-edits: ~12-15s)
- Database connections
- Error rates

## Troubleshooting

### Build Fails

**Error: "Cannot find module"**
```bash
# Ensure dependencies are in dependencies, not devDependencies
npm install --save missing-package
```

**Error: "TypeScript compilation failed"**
```bash
# Check TypeScript configuration
npm run build # Test locally first
```

### Runtime Errors

**Error: "Database connection failed"**
- Verify `DATABASE_URL` environment variable is set
- Check PostgreSQL service is running
- Verify migration was run successfully

**Error: "CORS blocked"**
- Check CORS configuration in `index.ts`
- Verify Figma manifest includes your Railway domain

**Error: "API key invalid"**
- Check `OPENROUTER_API_KEY` or `GEMINI_API_KEY` in Railway variables
- Verify no extra spaces or quotes

### Plugin Connection Issues

**Figma shows "Network request failed"**
1. Check Railway URL is correct in `ui.html`
2. Verify domain is in `manifest.json` → `networkAccess.allowedDomains`
3. Rebuild plugin: `npm run build`
4. Reload plugin in Figma

## Cost Estimation

### Railway Free Tier
- $5 credit per month
- Covers ~550 hours of execution time
- Plus PostgreSQL database

### Expected Usage
- Server: ~$5-10/month (always on)
- PostgreSQL: ~$5/month (500MB storage)
- **Total: ~$10-15/month**

### OpenRouter Costs
- Rename (Gemini 2.5 Flash): ~$0.00015 per request
- Generate Edits (Gemini 3 Pro): ~$0.002 per request
- Image Generation: ~$0.003 per image

**Example monthly usage:**
- 1000 renames: $0.15
- 200 generate-edits: $0.40
- 100 AI images: $0.30
- **Total AI costs: ~$1/month**

## Production Checklist

Before going live:

- [ ] Environment variables configured in Railway
- [ ] PostgreSQL database created and migration run
- [ ] Railway URL updated in `ui.html`
- [ ] Railway URL added to `manifest.json`
- [ ] Plugin rebuilt with `npm run build`
- [ ] Plugin tested in Figma with all features
- [ ] API health check returns 200
- [ ] Database jobs table receiving records
- [ ] Error monitoring set up (optional: Sentry, LogRocket)
- [ ] Rate limits configured appropriately

## Updating the Deployment

To deploy updates:

1. **Commit and push changes:**
   ```bash
   git add .
   git commit -m "Update: description of changes"
   git push
   ```

2. **Railway auto-deploys:**
   - Watches your GitHub repo
   - Auto-deploys on push to main branch
   - Zero-downtime deployments

3. **Manual deploy (if needed):**
   ```bash
   railway up
   ```

## Support

- **Railway Docs**: https://docs.railway.com
- **Railway Discord**: https://discord.gg/railway
- **Project Issues**: [Your GitHub repo]/issues

## Sources
- [Deploy Node.js & Express API - Railway Docs](https://docs.railway.com/guides/deploy-node-express-api-with-auto-scaling-secrets-and-zero-downtime)
- [Nixpacks Configuration - Railway Docs](https://docs.railway.com/reference/nixpacks)
- [Build Configuration - Nixpacks](https://nixpacks.com/docs/guides/configuring-builds)
