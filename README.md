# LinkedIn Multi-Client Automation

Watches each client's Google Drive folder, generates a caption + hashtags (Groq, falling back to Gemini) using that client's business info and the filename, and posts to their LinkedIn Company Page. Runs a rolling 7-day schedule per client and never reposts the same file twice. One daily cron (9 AM IST by default) drives everything.

## 1. Supabase setup

1. Create a project at [supabase.com](https://supabase.com) (free tier is fine).
2. Go to the SQL Editor and run everything in `supabase/schema.sql` — this creates the `clients` and `scheduled_posts` tables.
3. Go to Project Settings → API and copy:
   - **Project URL** → `SUPABASE_URL`
   - **service_role key** (not the anon key — this backend needs full access) → `SUPABASE_SERVICE_ROLE_KEY`

## 2. Google Drive setup

1. [Google Cloud Console](https://console.cloud.google.com/) → enable the **Google Drive API**.
2. Create a **Service Account**, generate a JSON key.
3. **Local dev**: save the key as `service-account.json` in the project root, keep `GOOGLE_SERVICE_ACCOUNT_KEY_PATH=./service-account.json`.
4. **Render deploy**: you can't easily ship a file, so instead paste the *entire* JSON key as one line into `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` (an env var). The app checks this first before falling back to the file path.
5. Share each client's Drive folder with the service account's email (Viewer access).

## 3. AI providers

- **Groq**: key from [console.groq.com](https://console.groq.com) → `GROQ_API_KEY`. Model defaults to `openai/gpt-oss-20b` (`GROQ_MODEL` to change).
- **Gemini** (fallback): key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → `GEMINI_API_KEY`. Free tier is sufficient for this volume. Model defaults to `gemini-2.0-flash`.

If Groq fails for any reason (rate limit, deprecated model, outage), the app automatically retries with Gemini — no manual intervention needed.

## 4. LinkedIn setup

1. In your LinkedIn Developer App → **Auth** tab, note the **Client ID** and **Client Secret**.
2. Add a redirect URL matching where you're running this:
   - Local: `http://localhost:3000/auth/linkedin/callback`
   - Render: `https://your-app.onrender.com/auth/linkedin/callback`
3. Set `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, and `AUTH_CALLBACK_HOST` (the base URL matching whichever redirect you registered) in `.env` / Render env vars.
4. Run the app, open the dashboard, click **Connect LinkedIn**, approve access.
   - Locally, the token is written straight into `.env`.
   - On Render, the token takes effect immediately in the running process, but **won't survive a redeploy** unless you also copy it into the `LINKEDIN_ACCESS_TOKEN` environment variable in Render's dashboard (the success page reminds you of this).
5. Tokens last ~60 days. When one expires, click **Connect LinkedIn** again.

## 5. Add clients

Open the dashboard and use the **Add client** form: name, LinkedIn page URL/ID, Drive folder ID, business description, website, phone, email, hashtag count, caption style. All of this feeds into the AI prompt so captions sound like *that* business, not generic filler.

## 6. How scheduling works

Once a day (9 AM IST by default, configurable via `DAILY_CRON` / `TIMEZONE`):

1. For each client, the app checks the next 7 days. Any day without a queued post gets one — pulling from Drive files that have **never** been scheduled for that client before (enforced by a database constraint, so a file can never repeat).
2. Whatever's scheduled for **today** gets posted immediately: downloaded from Drive, captioned by AI, uploaded to LinkedIn, and marked `posted` (or `failed` with the error saved, visible in the dashboard).
3. If a client's Drive folder runs out of unused files, that day's slot just stays empty until you add more files — nothing crashes.

You can also hit **Run daily job now** in the dashboard any time to trigger this manually (useful for testing).

## 7. Run locally

```bash
npm install
cp .env.example .env   # fill in everything above
npm start
```

Dashboard at `http://localhost:4000`.

## 8. Deploy to Render

1. Push this project to a GitHub repo.
2. In Render: **New → Web Service**, connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add all the environment variables from `.env.example` in Render's Environment tab — including `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` (paste full key JSON), and set `AUTH_CALLBACK_HOST` to your Render URL (e.g. `https://your-app.onrender.com`).
5. Render's free web services can spin down after inactivity — if that happens, the internal 9 AM cron won't fire because the process isn't running. Two options:
   - Upgrade to a paid Render instance (always-on), or
   - Use a free external pinger (e.g. UptimeRobot hitting your dashboard URL every few minutes) to keep it awake — a common workaround for this exact situation.
6. Once deployed, visit your Render URL, click **Connect LinkedIn**, and copy the resulting token into Render's `LINKEDIN_ACCESS_TOKEN` env var so it survives restarts.

## Notes & limitations

- **Video uploads** use a single-part upload — fine for short clips, not huge files. Ask if you need chunked multi-part upload for larger videos.
- **Caption quality** depends on filename — name Drive files descriptively (e.g. `founder-interview-fintech-2026.jpg`, not `IMG_4021.jpg`).
- **Token refresh isn't automatic** outside LinkedIn's Marketing Developer Platform partner program — budget for re-clicking "Connect LinkedIn" every ~60 days.
- **LinkedIn API version** is pinned in `src/linkedinClient.js` (`LINKEDIN_VERSION`) — LinkedIn deprecates versions after about a year, so this will need bumping periodically.
