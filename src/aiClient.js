const Groq = require('groq-sdk');
const axios = require('axios');

const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

function buildPrompt(client, fileName) {
  const cleanName = fileName.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ').trim();
  const hashtagCount = client.hashtag_count || 5;

  const businessLines = [
    client.business_description && `Business description: ${client.business_description}`,
    client.website && `Website: ${client.website}`,
    client.phone && `Phone: ${client.phone}`,
    client.email && `Email: ${client.email}`,
  ].filter(Boolean).join('\n');

  return `You are writing a LinkedIn post for the company page "${client.name}".
${businessLines}

The post is about a media file named: "${cleanName}"
Tone/style: ${client.caption_style || 'professional and engaging, 2-3 short sentences'}

Write:
1. A caption (2-4 sentences, no hashtags in this part). Naturally weave in the business's value proposition where relevant, but don't force the phone/email/website into the caption text itself unless it flows naturally.
2. Exactly ${hashtagCount} relevant hashtags

Respond ONLY in this exact JSON format, nothing else, no markdown fences:
{"caption": "...", "hashtags": ["#tag1", "#tag2"]}`;
}

function parseResponse(raw) {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { caption: raw.trim(), hashtags: [] };
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      caption: parsed.caption || raw.trim(),
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
    };
  } catch {
    return { caption: raw.trim(), hashtags: [] };
  }
}

async function generateWithGroq(prompt) {
  const completion = await groq.chat.completions.create({
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 400,
  });
  return completion.choices[0].message.content.trim();
}

async function generateWithGemini(prompt) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await axios.post(url, {
    contents: [{ parts: [{ text: prompt }] }],
  });
  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no content');
  return text.trim();
}

/**
 * Generates a caption + hashtags for a client's post, trying Groq first
 * and falling back to Gemini if Groq errors for any reason.
 */
async function generateCaption(client, fileName) {
  const prompt = buildPrompt(client, fileName);
  let lastError;

  if (groq) {
    try {
      const raw = await generateWithGroq(prompt);
      return { ...parseResponse(raw), provider: 'groq' };
    } catch (err) {
      lastError = err;
      console.warn(`[aiClient] Groq failed (${err.message}), falling back to Gemini`);
    }
  }

  if (process.env.GEMINI_API_KEY) {
    try {
      const raw = await generateWithGemini(prompt);
      return { ...parseResponse(raw), provider: 'gemini' };
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`Both Groq and Gemini failed to generate a caption: ${lastError?.message || 'no providers configured'}`);
}

module.exports = { generateCaption };
