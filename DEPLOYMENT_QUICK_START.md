# 🚀 Quick Start: Deploy to Railway

## ✅ Pre-Deployment Checklist

Your project is **100% ready** for Railway deployment! Here's what we've prepared:

### Files Added
- ✅ `server/railway.json` - Railway deployment config
- ✅ `server/nixpacks.toml` - Build configuration
- ✅ `server/.gitignore` - Excludes secrets and build artifacts
- ✅ `server/RAILWAY_DEPLOYMENT.md` - Complete deployment guide
- ✅ `server/migrations/001_initial.sql` - Database schema

### Files Updated
- ✅ `server/package.json` - Production-ready build and start scripts
- ✅ `ui.html` - Ready for Railway URL (just update line 510)
- ✅ `server/.env.example` - Template for environment variables

## 📝 3-Step Deployment

### Step 1: Deploy Server (5 minutes)

1. **Go to Railway:** https://railway.app/new
2. **Deploy from GitHub:** Select your repository
3. **Set root directory:** `server`
4. **Add PostgreSQL:** Click "+ New" → "Database" → "PostgreSQL"

### Step 2: Configure Environment (2 minutes)

In Railway → Variables tab, add:
```bash
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=your-key-here
EDIT_PROMPT_FILE=creative-director-with-images.txt
NODE_ENV=production
```

Railway auto-sets: `DATABASE_URL`, `PORT`

### Step 3: Connect Plugin (3 minutes)

1. **Get your Railway URL:**
   - Railway dashboard → Settings → Domains
   - Copy: `https://your-app.up.railway.app`

2. **Update 2 files in your local code:**

   **File 1: `ui.html` (line 510)**
   ```javascript
   const BACKEND_URL = 'https://your-app.up.railway.app'; // Your Railway URL
   ```

   **File 2: `manifest.json`**
   ```json
   "allowedDomains": [
     "https://cdnjs.cloudflare.com",
     "https://fonts.googleapis.com",
     "https://fonts.gstatic.com",
     "https://your-app.up.railway.app"  // Add this line
   ]
   ```

3. **Rebuild plugin:**
   ```bash
   npm run build
   ```

4. **Reload in Figma:**
   - Delete old plugin
   - Import from manifest again

## ✅ Done!

Your Figma plugin is now connected to Railway!

## 📊 Post-Deployment

### Run Database Migration

**Option A: Railway CLI**
```bash
railway login
cd server
railway run psql $DATABASE_URL -f migrations/001_initial.sql
```

**Option B: Railway Dashboard**
- PostgreSQL service → Data tab → Query
- Paste contents of `migrations/001_initial.sql`
- Execute

### Verify Deployment

```bash
# Health check
curl https://your-app.up.railway.app/health
# Should return: {"status":"ok","service":"exporter-server"}

# Check prompts
curl https://your-app.up.railway.app/api/prompts
# Should return list of available prompts
```

### Test in Figma

1. Select a frame
2. Run plugin
3. Try all features:
   - ✅ AI Rename Layers
   - ✅ Generate Edits (test different prompts)
   - ✅ AI Image Generation

## 💰 Expected Costs

- **Railway**: ~$10-15/month (server + PostgreSQL)
- **OpenRouter AI**: ~$1/month (with moderate usage)
- **Total**: ~$11-16/month

## 📚 Need Help?

See detailed guide: `server/RAILWAY_DEPLOYMENT.md`

## 🔗 Sources

- [Deploy Node.js & Express API - Railway Docs](https://docs.railway.com/guides/deploy-node-express-api-with-auto-scaling-secrets-and-zero-downtime)
- [Nixpacks Configuration](https://docs.railway.com/reference/nixpacks)
- [Build Configuration](https://nixpacks.com/docs/guides/configuring-builds)
