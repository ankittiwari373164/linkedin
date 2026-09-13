const supabase = require('./supabaseClient');
const mime = require('mime-types');
const fs = require('fs');

const { getDriveClient, listMediaFiles, downloadFile } = require('./driveClient');
const { generateCaption } = require('./aiClient');
const { uploadImage, uploadVideo, createPost } = require('./linkedinClient');

const SLOTS_AHEAD = 4; // always keep this many upcoming posts queued, regardless of frequency

function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function addDaysISO(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function getClients() {
  const { data, error } = await supabase.from('clients').select('*');
  if (error) throw error;
  return data || [];
}

/**
 * Tops up this client's queue so at least SLOTS_AHEAD future/today posts
 * are always scheduled, spaced `frequency_days` apart, using Drive files
 * that have never been scheduled for this client before.
 */
async function topUpSchedule(client, drive) {
  const today = todayISO(0);
  const freq = Math.max(1, client.frequency_days || 1);

  const { data: futureRows, error: futureErr } = await supabase
    .from('scheduled_posts')
    .select('scheduled_date')
    .eq('client_id', client.id)
    .in('status', ['pending', 'posted'])
    .gte('scheduled_date', today)
    .order('scheduled_date', { ascending: false });
  if (futureErr) throw futureErr;

  const needed = SLOTS_AHEAD - futureRows.length;
  if (needed <= 0) return;

  let nextDate = futureRows.length > 0 ? addDaysISO(futureRows[0].scheduled_date, freq) : today;
  const newDates = [];
  for (let i = 0; i < needed; i++) {
    newDates.push(nextDate);
    nextDate = addDaysISO(nextDate, freq);
  }

  const { data: usedRows, error: usedErr } = await supabase
    .from('scheduled_posts')
    .select('drive_file_id')
    .eq('client_id', client.id);
  if (usedErr) throw usedErr;
  const usedIds = new Set(usedRows.map((r) => r.drive_file_id));

  const allFiles = await listMediaFiles(drive, client.drive_folder_id, client.content_type || 'both');
  const freshFiles = allFiles.filter((f) => !usedIds.has(f.id));

  if (freshFiles.length === 0) {
    console.log(`[${client.name}] No unused ${client.content_type || 'media'} files left to schedule.`);
    return;
  }

  const toSchedule = freshFiles.slice(0, newDates.length);
  const rows = toSchedule.map((file, i) => ({
    client_id: client.id,
    drive_file_id: file.id,
    file_name: file.name,
    mime_type: file.mimeType,
    scheduled_date: newDates[i],
    status: 'pending',
  }));

  const { error: insertErr } = await supabase.from('scheduled_posts').insert(rows);
  if (insertErr) throw insertErr;
  console.log(`[${client.name}] Queued ${rows.length} new post(s): ${newDates.slice(0, rows.length).join(', ')}`);
}

/**
 * Posts a single scheduled_posts row right now, regardless of its
 * scheduled_date. Used both by the daily "post what's due today" pass
 * and by manual retries of failed posts.
 */
async function postSingle(client, row, drive) {
  let localPath;
  try {
    console.log(`[${client.name}] Posting ${row.file_name}`);
    localPath = await downloadFile(drive, row.drive_file_id, row.file_name);

    const { caption, hashtags, provider } = await generateCaption(client, row.file_name);
    const fullText = `${caption}\n\n${hashtags.join(' ')}`.trim();

    const isVideo = (row.mime_type || mime.lookup(row.file_name) || '').startsWith('video/');
    const mediaUrn = isVideo
      ? await uploadVideo(process.env.LINKEDIN_ACCESS_TOKEN, client.organization_urn, localPath)
      : await uploadImage(process.env.LINKEDIN_ACCESS_TOKEN, client.organization_urn, localPath);

    const postId = await createPost(process.env.LINKEDIN_ACCESS_TOKEN, {
      organizationUrn: client.organization_urn,
      text: fullText,
      mediaUrn,
    });

    await supabase
      .from('scheduled_posts')
      .update({
        status: 'posted',
        caption,
        hashtags,
        linkedin_post_id: String(postId),
        posted_at: new Date().toISOString(),
        error: null,
      })
      .eq('id', row.id);

    console.log(`[${client.name}] Posted via ${provider}. LinkedIn post ID: ${postId}`);
    return { ok: true };
  } catch (err) {
    const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[${client.name}] FAILED on ${row.file_name}:`, msg);
    await supabase.from('scheduled_posts').update({ status: 'failed', error: msg }).eq('id', row.id);
    return { ok: false, error: msg };
  } finally {
    if (localPath && fs.existsSync(localPath)) fs.unlinkSync(localPath);
  }
}

async function postDueToday(client, drive) {
  const today = todayISO(0);
  const { data: dueRows, error } = await supabase
    .from('scheduled_posts')
    .select('*')
    .eq('client_id', client.id)
    .eq('scheduled_date', today)
    .eq('status', 'pending');
  if (error) throw error;

  for (const row of dueRows) {
    await postSingle(client, row, drive);
  }
}

async function retryPost(rowId) {
  const { data: row, error } = await supabase.from('scheduled_posts').select('*').eq('id', rowId).single();
  if (error || !row) throw new Error('Scheduled post not found.');

  const { data: client, error: clientErr } = await supabase.from('clients').select('*').eq('id', row.client_id).single();
  if (clientErr || !client) throw new Error('Client not found for this post.');

  const drive = getDriveClient();
  return postSingle(client, row, drive);
}

async function runDaily() {
  const clients = await getClients();
  const drive = getDriveClient();

  for (const client of clients) {
    try {
      await topUpSchedule(client, drive);
      await postDueToday(client, drive);
    } catch (err) {
      console.error(`[${client.name}] Daily job error:`, err.message);
    }
  }
}

module.exports = { runDaily, topUpSchedule, postDueToday, postSingle, retryPost, getClients };