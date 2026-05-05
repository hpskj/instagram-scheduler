const axios = require('axios');
require('dotenv').config();

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

function requireInstagramConfig() {
  if (!process.env.IG_USER_ID || !process.env.IG_ACCESS_TOKEN) {
    throw new Error('Missing IG_USER_ID or IG_ACCESS_TOKEN in .env');
  }
}

async function createMediaContainer({ imageUrl, caption }) {
  requireInstagramConfig();
  const url = `${GRAPH_BASE}/${process.env.IG_USER_ID}/media`;
  const response = await axios.post(url, null, {
    params: {
      image_url: imageUrl,
      caption: caption || '',
      access_token: process.env.IG_ACCESS_TOKEN
    }
  });
  return response.data.id;
}

async function publishMedia({ creationId }) {
  requireInstagramConfig();
  const url = `${GRAPH_BASE}/${process.env.IG_USER_ID}/media_publish`;
  const response = await axios.post(url, null, {
    params: {
      creation_id: creationId,
      access_token: process.env.IG_ACCESS_TOKEN
    }
  });
  return response.data.id;
}

async function publishInstagramImage({ imageUrl, caption }) {
  const creationId = await createMediaContainer({ imageUrl, caption });
  // Instagram may need a short moment to process the container.
  await new Promise(resolve => setTimeout(resolve, 5000));
  const mediaId = await publishMedia({ creationId });
  return { creationId, mediaId };
}

module.exports = { publishInstagramImage };
