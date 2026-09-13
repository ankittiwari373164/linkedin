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

CRITICAL FORMAT RULES:
- Respond with ONLY a single JSON object, nothing before or after it - no markdown code fences, no commentary.
- The JSON must be valid: the caption value must be on a single line with no literal line breaks (use spaces instead of newlines between sentences).
- Do not escape or include any characters that would break JSON parsing.

Format exactly like this:
{"caption": "Your caption text here as one continuous line.", "hashtags": ["#tag1", "#tag2"]}`;
}

/**
 * Robustly extracts {caption, hashtags} from a model response. Tries several
 * increasingly lenient strategies before giving up. Returns null (never a
 * best-effort guess) if nothing usable could be parsed, so callers can treat
 * that as a hard failure rather than risk posting malformed content.
 */
function parseResponse(raw) {
  let text = raw.trim();

  // Strip markdown code fences if present, e.g. ```json ... ```
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

  // Isolate the outermost { ... } block.
  const match = text.match(/\{[\s\S]*\}/);
  if (match) text = match[0];

  const tryParse = (candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed.caption === 'string') {
        return {
          caption: parsed.caption.trim(),
          hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
        };
      }
    } catch {
      // fall through
    }
    return null;
  };

  // Attempt 1: parse as-is.
  let result = tryParse(text);
  if (result) return result;

  // Attempt 2: the most common failure mode is literal newlines/tabs inside
  // string values, which are illegal in strict JSON. Collapse them.
  const sanitized = text.replace(/[\r\n\t]+/g, ' ');
  result = tryParse(sanitized);
  if (result) return result;

  // Attempt 3: sometimes models leave a trailing comma before a closing
  // brace/bracket, which also breaks strict JSON.
  const noTrailingCommas = sanitized.replace(/,(\s*[}\]])/g, '$1');
  result = tryParse(noTrailingCommas);
  if (result) return result;

  return null; // caller must treat this as a failure, not fall back to raw text
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
 * and falling back to Gemini if Groq errors OR returns unparseable output.
 * Throws if neither provider yields valid, parseable JSON - callers must
 * NOT post anything in that case.
 */
async function generateCaption(client, fileName) {
  const prompt = buildPrompt(client, fileName);
  const errors = [];

  if (groq) {
    try {
      const raw = await generateWithGroq(prompt);
      const parsed = parseResponse(raw);
      if (parsed) return { ...parsed, provider: 'groq' };
      errors.push('Groq returned unparseable JSON');
      console.warn('[aiClient] Groq response failed to parse, falling back to Gemini. Raw:', raw.slice(0, 200));
    } catch (err) {
      errors.push(`Groq error: ${err.message}`);
      console.warn(`[aiClient] Groq request failed (${err.message}), falling back to Gemini`);
    }
  }

  if (process.env.GEMINI_API_KEY) {
    try {
      const raw = await generateWithGemini(prompt);
      const parsed = parseResponse(raw);
      if (parsed) return { ...parsed, provider: 'gemini' };
      errors.push('Gemini returned unparseable JSON');
    } catch (err) {
      errors.push(`Gemini error: ${err.message}`);
    }
  }

  throw new Error(`Caption generation failed - refusing to post malformed content. Details: ${errors.join(' | ') || 'no providers configured'}`);
}

module.exports = { generateCaption, parseResponse };