const axios = require('axios');
const fs = require('fs');
const mime = require('mime-types');

const API_BASE = 'https://api.linkedin.com/rest';
const LINKEDIN_VERSION = '202608'; // bump periodically - LinkedIn versions are YYYYMM, supported ~1yr

function headers(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'LinkedIn-Version': LINKEDIN_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
    'Content-Type': 'application/json',
  };
}

async function uploadImage(accessToken, organizationUrn, filePath) {
  const initRes = await axios.post(
    `${API_BASE}/images?action=initializeUpload`,
    { initializeUploadRequest: { owner: organizationUrn } },
    { headers: headers(accessToken) }
  );
  const { uploadUrl, image } = initRes.data.value;
  const fileBuffer = fs.readFileSync(filePath);
  await axios.put(uploadUrl, fileBuffer, {
    headers: { 'Content-Type': mime.lookup(filePath) || 'application/octet-stream' },
  });
  return image;
}

/**
 * Uploads a video using LinkedIn's full multi-part upload flow: splits the
 * file into the byte-range chunks LinkedIn specifies, uploads each chunk,
 * captures the ETag header LinkedIn returns per chunk, then finalizes the
 * upload with those ETags. Required for anything beyond a tiny video -
 * single-part upload gets rejected with 413 on real-sized files.
 */
async function uploadVideo(accessToken, organizationUrn, filePath) {
  const fileSize = fs.statSync(filePath).size;

  const initRes = await axios.post(
    `${API_BASE}/videos?action=initializeUpload`,
    {
      initializeUploadRequest: {
        owner: organizationUrn,
        fileSizeBytes: fileSize,
        uploadCaptions: false,
        uploadThumbnail: false,
      },
    },
    { headers: headers(accessToken) }
  );

  const { uploadInstructions, video, uploadToken } = initRes.data.value;
  const fileBuffer = fs.readFileSync(filePath);

  const uploadedPartIds = [];
  for (const part of uploadInstructions) {
    // LinkedIn's byte ranges are inclusive on both ends.
    const chunk = fileBuffer.subarray(part.firstByte, part.lastByte + 1);
    const putRes = await axios.put(part.uploadUrl, chunk, {
      headers: { 'Content-Type': 'application/octet-stream' },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    const etag = putRes.headers.etag || putRes.headers.ETag;
    if (!etag) throw new Error(`LinkedIn did not return an ETag for video part [${part.firstByte}-${part.lastByte}]`);
    uploadedPartIds.push(etag);
  }

  await axios.post(
    `${API_BASE}/videos?action=finalizeUpload`,
    {
      finalizeUploadRequest: {
        video,
        uploadToken: uploadToken || '',
        uploadedPartIds,
      },
    },
    { headers: headers(accessToken) }
  );

  return video;
}

async function createPost(accessToken, { organizationUrn, text, mediaUrn }) {
  const body = {
    author: organizationUrn,
    commentary: text,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
  if (mediaUrn) body.content = { media: { id: mediaUrn } };

  const res = await axios.post(`${API_BASE}/posts`, body, { headers: headers(accessToken) });
  return res.headers['x-restli-id'] || res.data;
}

module.exports = { uploadImage, uploadVideo, createPost, LINKEDIN_VERSION };