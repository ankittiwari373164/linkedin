require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');

const supabase = require('./supabaseClient');
const { runDaily, retryPost } = require('./dailyJob');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function parseOrgInput(input) {
  const trimmed = String(input).trim();
  if (trimmed.startsWith('urn:li:organization:')) return trimmed;
  const match = trimmed.match(/company\/(\d+)/);
  if (match) return `urn:li:organization:${match[1]}`;
  if (/^\d+$/.test(trimmed)) return `urn:li:organization:${trimmed}`;
  return null;
}

// --- Clients CRUD ---

app.get('/api/clients', async (req, res) => {
  const { data, error } = await supabase.from('clients').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/clients', async (req, res) => {
  const { name, pageIdOrUrl, driveFolderId, businessDescription, website, phone, email, captionStyle, hashtagCount, contentType, frequencyDays } = req.body;

  if (!name || !pageIdOrUrl || !driveFolderId) {
    return res.status(400).json({ error: 'name, pageIdOrUrl, and driveFolderId are required.' });
  }
  const organizationUrn = parseOrgInput(pageIdOrUrl);
  if (!organizationUrn) return res.status(400).json({ error: 'Could not parse a LinkedIn org ID from that input.' });

  const { error } = await supabase.from('clients').insert({
    name,
    organization_urn: organizationUrn,
    drive_folder_id: driveFolderId,
    business_description: businessDescription || null,
    website: website || null,
    phone: phone || null,
    email: email || null,
    caption_style: captionStyle || 'professional and engaging, 2-3 short sentences',
    hashtag_count: hashtagCount ? Number(hashtagCount) : 5,
    content_type: contentType || 'both',
    frequency_days: frequencyDays ? Number(frequencyDays) : 1,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ ok: true });
});

app.put('/api/clients/:id', async (req, res) => {
  const { pageIdOrUrl, driveFolderId, businessDescription, website, phone, email, captionStyle, hashtagCount, contentType, frequencyDays } = req.body;
  const update = {};
  if (pageIdOrUrl) {
    const urn = parseOrgInput(pageIdOrUrl);
    if (!urn) return res.status(400).json({ error: 'Could not parse LinkedIn org ID.' });
    update.organization_urn = urn;
  }
  if (driveFolderId) update.drive_folder_id = driveFolderId;
  if (businessDescription !== undefined) update.business_description = businessDescription;
  if (website !== undefined) update.website = website;
  if (phone !== undefined) update.phone = phone;
  if (email !== undefined) update.email = email;
  if (captionStyle !== undefined) update.caption_style = captionStyle;
  if (hashtagCount) update.hashtag_count = Number(hashtagCount);
  if (contentType) update.content_type = contentType;
  if (frequencyDays) update.frequency_days = Number(frequencyDays);

  const { error } = await supabase.from('clients').update(update).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete('/api/clients/:id', async (req, res) => {
  const { error } = await supabase.from('clients').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// --- Schedule + activity views ---

app.get('/api/schedule', async (req, res) => {
  const { data, error } = await supabase
    .from('scheduled_posts')
    .select('*, clients(name)')
    .order('scheduled_date', { ascending: true })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// --- Manual run triggers ---

app.post('/api/run-daily', async (req, res) => {
  try {
    await runDaily();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scheduled-posts/:id/retry', async (req, res) => {
  try {
    const result = await retryPost(req.params.id);
    if (!result.ok) return res.status(500).json({ error: result.error });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- LinkedIn OAuth ---

app.get('/api/oauth-url', (req, res) => {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const host = process.env.AUTH_CALLBACK_HOST || `http://localhost:${process.env.AUTH_CALLBACK_PORT || 3000}`;
  if (!clientId) return res.status(400).json({ error: 'Set LINKEDIN_CLIENT_ID in .env first.' });

  const redirectUri = `${host}/auth/linkedin/callback`;
  const state = Math.random().toString(36).slice(2);
  const scope = 'w_organization_social r_organization_social';
  const url = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=${encodeURIComponent(scope)}`;
  res.json({ url });
});

app.get('/auth/linkedin/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) return res.status(400).send(`<h2>LinkedIn error</h2><p>${error}: ${error_description}</p>`);
  if (!code) return res.status(400).send('<h2>No authorization code in callback.</h2>');

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  const host = process.env.AUTH_CALLBACK_HOST || `http://localhost:${process.env.AUTH_CALLBACK_PORT || 3000}`;
  if (!clientId || !clientSecret) {
    return res.status(500).send('<h2>Missing LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET in .env</h2>');
  }

  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${host}/auth/linkedin/callback`,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const tokenRes = await axios.post('https://www.linkedin.com/oauth/v2/accessToken', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const { access_token, expires_in } = tokenRes.data;

    // Local dev convenience: persist into .env if one exists on disk.
    const envPath = path.resolve(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      let envContent = fs.readFileSync(envPath, 'utf-8');
      envContent = envContent.match(/^LINKEDIN_ACCESS_TOKEN=.*$/m)
        ? envContent.replace(/^LINKEDIN_ACCESS_TOKEN=.*$/m, `LINKEDIN_ACCESS_TOKEN=${access_token}`)
        : envContent + `\nLINKEDIN_ACCESS_TOKEN=${access_token}\n`;
      fs.writeFileSync(envPath, envContent);
    }
    process.env.LINKEDIN_ACCESS_TOKEN = access_token; // take effect immediately for this running process

    const days = Math.round(expires_in / 86400);
    res.send(`<html><body style="font-family:sans-serif;padding:40px;max-width:600px;">
      <h2>✅ Access token saved</h2>
      <p>Valid for about ${days} days. This process now has the new token in memory.</p>
      <p><strong>On Render:</strong> also update the LINKEDIN_ACCESS_TOKEN environment variable in your service settings so it survives restarts/redeploys.</p>
    </body></html>`);
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    res.status(500).send(`<h2>Token exchange failed</h2><pre>${detail}</pre>`);
  }
});

const PORT = process.env.DASHBOARD_PORT || 4000;
app.listen(PORT, () => console.log(`Dashboard running at http://localhost:${PORT}`));

// The OAuth callback must live on whatever host/port is registered as the
// redirect URL in the LinkedIn app. Locally that's a separate port (3000);
// on Render it's the same public URL/port as the dashboard, so this same
// app instance already serves /auth/linkedin/callback above - no second
// listener needed there. Only start a second local listener when running
// on localhost with a different callback port than the dashboard.
const authPort = Number(process.env.AUTH_CALLBACK_PORT || 3000);
if (authPort !== Number(PORT) && (process.env.AUTH_CALLBACK_HOST || '').includes('localhost')) {
  app.listen(authPort, () => console.log(`OAuth callback listener also running at http://localhost:${authPort}/auth/linkedin/callback`));
}

// --- Cron: daily job ---
const schedule = process.env.DAILY_CRON || '0 9 * * *';
const timezone = process.env.TIMEZONE || 'Asia/Kolkata';
console.log(`Scheduling daily job: "${schedule}" (${timezone})`);
cron.schedule(schedule, () => {
  console.log('Running daily job (cron trigger)...');
  runDaily().catch((err) => console.error('Daily job crashed:', err));
}, { timezone });