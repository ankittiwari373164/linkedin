const supabase = require('./supabaseClient');
const mime = require('mime-types');
const fs = require('fs');

const { getDriveClient, listMediaFiles, downloadFile } = require('./driveClient');
const { generateCaption } = require('./aiClient');
const { uploadImage, uploadVideo, createPost } = require('./linkedinClient');

function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function getClients() {
  const { data, error } = await supabase.from('clients').select('*');
  if (error) throw error;
  return data || [];
}

/**
 * Ensures this client has a scheduled_posts row for each of the next 7 days
 * (today..+6), using Drive files that have never been scheduled for this
 * client before. Skips dates that already have a row.
 */
async function topUpWeeklySchedule(client, drive) {
  const windowDates = Array.from({ length: 7 }, (_, i) => todayISO(i));

  const { data: existing, error: existingErr } = await supabase
    .from('scheduled_posts')
    .select('scheduled_date, drive_file_id')
    .eq('client_id', client.id)
    .gte('scheduled_date', windowDates[0])
    .lte('scheduled_date', windowDates[6]);
  if (existingErr) throw existingErr;

  const filledDates = new Set(existing.map((r) => r.scheduled_date));
  const missingDates = windowDates.filter((d) => !filledDates.has(d));
  if (missingDates.length === 0) return; // week already fully queued

  // Files ever scheduled for this client (any status) - never reuse these.
  const { data: usedRows, error: usedErr } = await supabase
    .from('scheduled_posts')
    .select('drive_file_id')
    .eq('client_id', client.id);
  if (usedErr) throw usedErr;
  const usedIds = new Set(usedRows.map((r) => r.drive_file_id));

  const allFiles = await listMediaFiles(drive, client.drive_folder_id);
  const freshFiles = allFiles.filter((f) => !usedIds.has(f.id));

  if (freshFiles.length === 0) {
    console.log(`[${client.name}] No unused files left in Drive folder to schedule.`);
    return;
  }

  const toSchedule = freshFiles.slice(0, missingDates.length);
  const rows = toSchedule.map((file, i) => ({
    client_id: client.id,
    drive_file_id: file.id,
    file_name: file.name,
    mime_type: file.mimeType,
    scheduled_date: missingDates[i],
    status: 'pending',
  }));

  const { error: insertErr } = await supabase.from('scheduled_posts').insert(rows);
  if (insertErr) throw insertErr;
  console.log(`[${client.name}] Queued ${rows.length} new post(s) for ${missingDates.slice(0, rows.length).join(', ')}`);
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
    let localPath;
    try {
      console.log(`[${client.name}] Posting ${row.file_name} (due ${today})`);
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
        })
        .eq('id', row.id);

      console.log(`[${client.name}] Posted via ${provider}. LinkedIn post ID: ${postId}`);
    } catch (err) {
      const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`[${client.name}] FAILED on ${row.file_name}:`, msg);
      await supabase.from('scheduled_posts').update({ status: 'failed', error: msg }).eq('id', row.id);
    } finally {
      if (localPath && fs.existsSync(localPath)) fs.unlinkSync(localPath);
    }
  }
}

async function runDaily() {
  const clients = await getClients();
  const drive = getDriveClient();

  for (const client of clients) {
    try {
      await topUpWeeklySchedule(client, drive);
      await postDueToday(client, drive);
    } catch (err) {
      console.error(`[${client.name}] Daily job error:`, err.message);
    }
  }
}

module.exports = { runDaily, topUpWeeklySchedule, postDueToday, getClients };
