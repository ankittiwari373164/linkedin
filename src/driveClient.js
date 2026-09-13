const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

function getDriveClient() {
  let authOptions = { scopes: SCOPES };

  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON) {
    authOptions.credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON);
  } else {
    authOptions.keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './service-account.json';
  }

  const auth = new google.auth.GoogleAuth(authOptions);
  return google.drive({ version: 'v3', auth });
}

async function listMediaFiles(drive, folderId, contentType = 'both') {
  let mimeFilter = "(mimeType contains 'image/' or mimeType contains 'video/')";
  if (contentType === 'image') mimeFilter = "mimeType contains 'image/'";
  if (contentType === 'video') mimeFilter = "mimeType contains 'video/'";

  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false and ${mimeFilter}`,
    fields: 'files(id, name, mimeType, createdTime)',
    orderBy: 'createdTime',
    pageSize: 100,
  });
  return res.data.files || [];
}

async function downloadFile(drive, fileId, fileName) {
  const destPath = path.join(os.tmpdir(), `${fileId}-${fileName}`);
  const dest = fs.createWriteStream(destPath);

  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  return new Promise((resolve, reject) => {
    res.data.on('end', () => resolve(destPath)).on('error', reject).pipe(dest);
  });
}

module.exports = { getDriveClient, listMediaFiles, downloadFile };