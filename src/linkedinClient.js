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
  const { uploadInstructions, video } = initRes.data.value;
  const fileBuffer = fs.readFileSync(filePath);
  const part = uploadInstructions[0]; // single-part; large videos need multi-part chunking
  await axios.put(part.uploadUrl, fileBuffer, {
    headers: { 'Content-Type': 'application/octet-stream' },
  });
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
