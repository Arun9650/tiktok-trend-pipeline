import 'dotenv/config';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

const SYSTEM_PROMPT = `You write reaction scripts for Stitching/Duetting other people's TikTok videos, for
WhiteBeard (whitebeard.ai), which makes the Pawn AI, a MetaTrader 5 plugin for FX/CFD brokers
and prop firms. It evaluates every incoming order in real time and automatically decides
whether to fill it internally (B-Book) or hedge it with the firm's liquidity provider (A-Book).
Install takes under 15 minutes, no setup fee, pay-per-volume-executed pricing.

The audience is FX/CFD brokers, prop firms, banks, and liquidity providers, specifically people
responsible for risk management and execution at those firms. B2B, not retail traders.

You're given the original video's caption as context. The person recording will Stitch or Duet
that clip, meaning the original plays first (or alongside), then this reaction plays. Write
ONLY the reaction half, don't restate or summarize the original clip's content back to the
viewer, they just watched it.

Rules:
- Open with a genuine reaction to the specific point the original video made, agree, disagree,
  or add a angle they missed. Not a generic "great point!", something with actual content.
- 2-3 short commentary beats connecting the original's point to real execution/risk-management
  mechanics, this is where the Pawn AI angle comes in naturally, not forced.
- Never give financial advice or specific trade calls.
- Every script must name WhiteBeard (or "the Pawn AI") at least once and describe what it does,
  not a vague "platform" claim.
- Close with a CTA aimed at a broker/prop firm risk manager. Put this in the dedicated "cta"
  field, not buried in the beats.
- Caption under 150 characters, must reference WhiteBeard. 3-5 focused hashtags.
- Output strict JSON only, no markdown fences, matching this shape:
{
  "reactionHook": "string",
  "commentaryBeats": ["string", "string"],
  "cta": "string",
  "caption": "string",
  "hashtags": ["string", "string", "string"],
  "estimatedDurationSec": 20
}`;

export async function generateStitchScript(sourceVideo) {
  if (!GROQ_API_KEY) throw new Error('Missing GROQ_API_KEY in .env');

  const userPrompt = `Original video caption: "${sourceVideo.text}"
Original video's share rate: ${(sourceVideo.shareRatio * 100).toFixed(2)}% (this is why it's worth stitching, people found it worth sending to someone)
Original video URL: ${sourceVideo.webVideoUrl}

Write a Stitch/Duet reaction script responding to this specific video.`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.8,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Groq request failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content ?? '';

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Groq returned non-JSON output, check the prompt or model:\n${raw}`);
  }

  const mentionsWhiteBeard = [parsed.reactionHook, ...(parsed.commentaryBeats || []), parsed.cta, parsed.caption]
    .join(' ')
    .toLowerCase()
    .includes('whitebeard');

  if (!mentionsWhiteBeard) {
    throw new Error('Generated stitch script never mentions WhiteBeard by name, rejecting before review. Try regenerating.');
  }

  return parsed;
}
