import { config } from './config.js';
import { runScraper, extractVideo } from './apifyClient.js';

// Stage 5 (part 1): pull the day's best-performing / trending sounds and attach
// the most relevant one to each ready-to-post video.
//
// PRD open question — where "today's best music" comes from. Two sources,
// selected by REPOST_SOUND_SOURCE:
//   'discovered' (default): rank the sounds we already saw on the scanned
//        high-performing videos. Zero extra cost and provably trending *in this
//        niche*, which matters more than a global chart for a finance account.
//   'apify': a dedicated trending-sounds actor run (REPOST_SOUND_ACTOR_ID).
//
// Honesty note (same constraint the generation pipeline documents): TikTok's
// Content Posting API can't legally bake in a copyrighted sound and doesn't
// expose the sound library. So an "attached" sound is carried as metadata —
// used to add the sound in-app on publish, or to mux a licensed/owned asset if
// REPOST_SOUND_ASSET_DIR provides one. We never claim to have muxed audio we
// don't have.

/** Rank sounds seen across the shortlist by combined plays + frequency. */
function soundsFromShortlist(shortlist) {
  const byId = new Map();
  for (const v of shortlist) {
    if (!v.sound?.id) continue;
    const cur = byId.get(v.sound.id) || { ...v.sound, uses: 0, plays: 0 };
    cur.uses += 1;
    cur.plays += v.plays || 0;
    byId.set(v.sound.id, cur);
  }
  return [...byId.values()].sort((a, b) => b.plays - a.plays || b.uses - a.uses);
}

async function soundsFromApify() {
  if (!config.trendingSoundActorId) {
    throw new Error('REPOST_SOUND_SOURCE=apify requires REPOST_SOUND_ACTOR_ID in .env');
  }
  // The input shape is specific to whichever trending-sounds actor you point
  // REPOST_SOUND_ACTOR_ID at; pass it through .env-driven overrides if needed.
  const items = await runScraper(
    { resultsPerPage: config.searchResultsPerTerm },
    config.trendingSoundActorId
  );
  // Different trending-sound actors return different shapes; extractVideo pulls
  // musicMeta the same way, so reuse it and dedupe by sound id.
  return soundsFromShortlist(items.map(extractVideo));
}

/**
 * Return today's trending sounds (ranked, best first).
 * @param {object[]} shortlist  the discovered videos (source for 'discovered').
 */
export async function getTrendingSounds(shortlist = []) {
  if (config.trendingSoundSource === 'apify') return soundsFromApify();
  return soundsFromShortlist(shortlist);
}

/**
 * Attach a trending sound to each edited video. Preference order:
 *  1. a different top-trending sound than the clip's own original (freshness),
 *  2. otherwise the top trending sound,
 *  3. otherwise keep the clip's original sound.
 */
export function attachSounds(editedVideos, trendingSounds) {
  const top = trendingSounds[0] || null;
  return editedVideos.map((v) => {
    const ownId = v.sound?.id;
    const fresh = trendingSounds.find((s) => s.id && s.id !== ownId) || top;
    const chosen = fresh || v.sound || null;
    return {
      ...v,
      trendingSound: chosen
        ? { id: chosen.id, name: chosen.name, author: chosen.author, playUrl: chosen.playUrl }
        : null,
    };
  });
}
