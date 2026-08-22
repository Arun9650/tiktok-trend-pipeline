import 'dotenv/config';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

const SYSTEM_PROMPT = `You write short-form TikTok scripts for WhiteBeard (whitebeard.ai), which makes the
Pawn AI, a custom MetaTrader 5 plugin for FX/CFD brokers and prop firms. It evaluates every
incoming order in real time and automatically decides whether to fill it internally (B-Book)
or hedge it with the firm's liquidity provider (A-Book), based on the firm's optimal inventory
at that millisecond. Install takes under 15 minutes, no setup fee, no monthly minimum, pricing
is pay-per-volume-executed.

The audience is FX/CFD brokers, prop firms, banks, and liquidity providers, specifically the
people responsible for risk management and execution at those firms. This is B2B. Not retail
traders, not people looking for trading signals or advice.

Rules:
- Hook in the first line. Question or bold claim, no throat-clearing.
- 3 short body beats max. Plain language, no jargon unless you explain it in the same breath.
  It's fine to name A-Book/B-Book since that's the audience's own vocabulary, just don't stack
  it with more unexplained jargon on top.
- Never give financial advice or specific trade calls. This isn't about trading strategy, it's
  about risk management infrastructure for firms.
- Use the trending hook/format as the entry point, then pivot the last beat toward WhiteBeard's
  actual product: real-time AI-driven A-Book/B-Book decisioning on MT5, per trade, 24/7. Every
  script must name WhiteBeard (or "the Pawn AI") at least once and describe what it actually
  does, not a vague "platform" claim.
- Close with a call to action aimed at a broker/prop firm risk manager watching. Examples:
  "DM WhiteBeard for a free simulation report on your book", "link in bio, see the Pawn AI in
  action", "book a demo, live the same day". Put this in the dedicated "cta" field, not buried
  in the beats.
- This is still a TikTok video, not an ad. Keep the trend-format hook and pacing, the WhiteBeard
  mention should feel like the payoff of the hook, not a jump cut into a pitch.
- Caption under 150 characters, must also reference WhiteBeard (name or @whitebeardai handle).
  3-5 focused hashtags, not a hashtag dump.
- Output strict JSON only, no markdown fences, matching this shape:
{
  "hook": "string",
  "beats": ["string", "string", "string"],
  "cta": "string",
  "caption": "string",
  "hashtags": ["string", "string", "string"],
  "suggestedSound": "string",
  "estimatedDurationSec": 30
}`;

export async function generateScript(trendGroup, marketContext = '') {
  if (!GROQ_API_KEY) throw new Error('Missing GROQ_API_KEY in .env');

  const example = trendGroup.examples[0];
  const userPrompt = `Trending sound: ${trendGroup.soundName || 'unspecified'}
Example high-performing caption on this trend: "${example.text}"
Share rate on that example: ${(example.shareRatio * 100).toFixed(2)}%
Video length reference: ${example.durationSec || 30} seconds

Today's market context (optional, use only if it strengthens the hook): ${marketContext || 'none provided'}

Write one new script in this style, tied to a WhiteBeard angle.`;

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

  const mentionsWhiteBeard = [parsed.hook, ...(parsed.beats || []), parsed.cta, parsed.caption]
    .join(' ')
    .toLowerCase()
    .includes('whitebeard');

  if (!mentionsWhiteBeard) {
    throw new Error('Generated script never mentions WhiteBeard by name, rejecting before review. Try regenerating.');
  }

  return parsed;
}