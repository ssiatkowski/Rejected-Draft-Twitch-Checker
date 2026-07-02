require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const cron = require("node-cron");

const {
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_GAME_ID,
  DISCORD_WEBHOOK,
  YOUTUBE_API_KEY,
  YOUTUBE_SEARCH_QUERY,
  PORT,
} = process.env;

const DATA_DIR = path.join(__dirname, "data");

const SEEN_TWITCH_FILE = path.join(DATA_DIR, "seen_streamers.json");
const LIVE_TWITCH_FILE = path.join(DATA_DIR, "currently_live.json");
const SEEN_YOUTUBE_FILE = path.join(DATA_DIR, "seen_youtube_videos.json");

const YOUTUBE_MIN_DATE = new Date("2026-06-01T00:00:00.000Z");

// Exact capitalization required in title.
const REQUIRED_YOUTUBE_TITLE_TEXT = "Rejected Draft";

// YouTube query can stay broad; exact filtering happens locally.
const YOUTUBE_QUERY = YOUTUBE_SEARCH_QUERY || "\"Rejected Draft\"";

// Prevent huge bursts on first deploy/redeploy.
const MAX_YOUTUBE_ALERTS_PER_CHECK = 5;

let twitchToken = null;
let twitchTokenExpiresAt = 0;

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required .env value: ${name}`);
}

requireEnv("TWITCH_CLIENT_ID", TWITCH_CLIENT_ID);
requireEnv("TWITCH_CLIENT_SECRET", TWITCH_CLIENT_SECRET);
requireEnv("TWITCH_GAME_ID", TWITCH_GAME_ID);
requireEnv("DISCORD_WEBHOOK", DISCORD_WEBHOOK);

function ensureFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

  for (const file of [SEEN_TWITCH_FILE, LIVE_TWITCH_FILE, SEEN_YOUTUBE_FILE]) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, "[]");
  }
}

function readJsonSet(file) {
  try {
    return new Set(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return new Set();
  }
}

function writeJsonSet(file, set) {
  fs.writeFileSync(file, JSON.stringify([...set], null, 2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtmlEntities(text) {
  if (!text) return "";

  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function startHealthServer() {
  const port = PORT || 3000;

  http
    .createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Rejected Draft Twitch + YouTube monitor is running.\n");
    })
    .listen(port, () => {
      console.log(`Health server listening on port ${port}`);
    });
}

async function getTwitchToken() {
  const now = Date.now();

  if (twitchToken && now < twitchTokenExpiresAt - 60_000) {
    return twitchToken;
  }

  const url =
    "https://id.twitch.tv/oauth2/token" +
    `?client_id=${encodeURIComponent(TWITCH_CLIENT_ID)}` +
    `&client_secret=${encodeURIComponent(TWITCH_CLIENT_SECRET)}` +
    "&grant_type=client_credentials";

  const res = await fetch(url, { method: "POST" });

  if (!res.ok) {
    throw new Error(`Twitch token error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();

  twitchToken = data.access_token;
  twitchTokenExpiresAt = now + data.expires_in * 1000;

  console.log("Fetched new Twitch token.");
  return twitchToken;
}

async function getLiveTwitchStreams() {
  const token = await getTwitchToken();

  const url =
    "https://api.twitch.tv/helix/streams" +
    `?game_id=${encodeURIComponent(TWITCH_GAME_ID)}` +
    "&first=100";

  const res = await fetch(url, {
    headers: {
      "Client-ID": TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Twitch streams error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  return data.data || [];
}

async function sendDiscordEmbed(embed, context = "Discord alert") {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (res.ok) return;

    const bodyText = await res.text();

    if (res.status === 429) {
      let retryAfterSeconds = 1;

      try {
        const parsed = JSON.parse(bodyText);
        retryAfterSeconds = Number(parsed.retry_after) || 1;
      } catch {
        retryAfterSeconds = Number(res.headers.get("retry-after")) || 1;
      }

      const waitMs = Math.ceil(retryAfterSeconds * 1000) + 250;

      console.warn(
        `${context} rate limited. Waiting ${waitMs}ms before retry ${attempt}/${maxAttempts}.`
      );

      await sleep(waitMs);
      continue;
    }

    throw new Error(`${context} error ${res.status}: ${bodyText}`);
  }

  throw new Error(`${context} failed after ${maxAttempts} attempts due to rate limits.`);
}

async function sendTwitchAlert(stream, isFirstTime) {
  const streamUrl = `https://twitch.tv/${stream.user_login}`;

  await sendDiscordEmbed(
    {
      title: isFirstTime
        ? "🚨 New first-time Rejected Draft streamer!"
        : "🔴 Rejected Draft streamer is live again!",
      description: [
        `**${stream.user_name}** is live now.`,
        "",
        `**Title:** ${stream.title || "No title"}`,
        `**Viewers:** ${stream.viewer_count}`,
        `**Language:** ${stream.language || "Unknown"}`,
        "",
        streamUrl,
      ].join("\n"),
      url: streamUrl,
      color: isFirstTime ? 15158332 : 5763719,
      thumbnail: {
        url: stream.thumbnail_url
          .replace("{width}", "320")
          .replace("{height}", "180"),
      },
      fields: [
        { name: "Streamer", value: stream.user_name, inline: true },
        { name: "First time?", value: isFirstTime ? "Yes ⭐" : "No", inline: true },
        { name: "Started at", value: stream.started_at || "Unknown", inline: false },
      ],
      timestamp: new Date().toISOString(),
    },
    "Twitch Discord alert"
  );
}

async function checkTwitchStreams() {
  ensureFiles();

  const seenStreamers = readJsonSet(SEEN_TWITCH_FILE);
  const currentlyLive = readJsonSet(LIVE_TWITCH_FILE);

  const streams = await getLiveTwitchStreams();
  const liveNow = new Set(streams.map((stream) => stream.user_id));

  for (const stream of streams) {
    if (currentlyLive.has(stream.user_id)) continue;

    const isFirstTime = !seenStreamers.has(stream.user_id);

    await sendTwitchAlert(stream, isFirstTime);

    seenStreamers.add(stream.user_id);
    writeJsonSet(SEEN_TWITCH_FILE, seenStreamers);

    console.log(`Twitch alert sent: ${stream.user_name} | firstTime=${isFirstTime}`);
  }

  writeJsonSet(LIVE_TWITCH_FILE, liveNow);

  console.log(`[${new Date().toISOString()}] Checked Twitch. Live streams: ${streams.length}`);
}

async function getRecentYouTubeVideos() {
  if (!YOUTUBE_API_KEY) {
    console.log("Skipping YouTube check: YOUTUBE_API_KEY not set.");
    return [];
  }

  const params = new URLSearchParams({
    part: "snippet",
    q: YOUTUBE_QUERY,
    type: "video",
    order: "date",
    maxResults: "25",
    publishedAfter: "2026-01-01T00:00:00Z",
    key: YOUTUBE_API_KEY,
  });

  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);

  if (!res.ok) {
    throw new Error(`YouTube search error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();

  return (data.items || [])
    .filter((item) => item.id && item.id.videoId && item.snippet)
    .map((item) => {
      const rawTitle = item.snippet.title || "";
      const title = decodeHtmlEntities(rawTitle);

      return {
        videoId: item.id.videoId,
        title,
        rawTitle,
        channelTitle: decodeHtmlEntities(item.snippet.channelTitle || "Unknown channel"),
        publishedAt: item.snippet.publishedAt,
        thumbnail:
          item.snippet.thumbnails?.medium?.url ||
          item.snippet.thumbnails?.default?.url ||
          null,
      };
    });
}

function shouldIgnoreYouTubeVideo(video) {
  const publishedDate = new Date(video.publishedAt);

  if (Number.isNaN(publishedDate.getTime())) {
    return {
      ignore: true,
      reason: "invalid publish date",
    };
  }

  if (publishedDate < YOUTUBE_MIN_DATE) {
    return {
      ignore: true,
      reason: "before June 2026",
    };
  }

  if (!video.title.includes(REQUIRED_YOUTUBE_TITLE_TEXT)) {
    return {
      ignore: true,
      reason: `title does not contain exact text "${REQUIRED_YOUTUBE_TITLE_TEXT}"`,
    };
  }

  return {
    ignore: false,
    reason: "eligible",
  };
}

async function sendYouTubeAlert(video) {
  const url = `https://www.youtube.com/watch?v=${video.videoId}`;

  await sendDiscordEmbed(
    {
      title: "📺 New Rejected Draft YouTube video found!",
      description: [
        `**${video.title}**`,
        "",
        `**Channel:** ${video.channelTitle}`,
        `**Published:** ${video.publishedAt}`,
        "",
        url,
      ].join("\n"),
      url,
      color: 16711680,
      thumbnail: video.thumbnail ? { url: video.thumbnail } : undefined,
      timestamp: new Date().toISOString(),
    },
    "YouTube Discord alert"
  );
}

async function checkYouTubeVideos() {
  ensureFiles();

  const seenVideos = readJsonSet(SEEN_YOUTUBE_FILE);
  const videos = await getRecentYouTubeVideos();

  let alertsSent = 0;

  // Oldest first, so alert order feels natural.
  for (const video of videos.reverse()) {
    if (seenVideos.has(video.videoId)) continue;

    const decision = shouldIgnoreYouTubeVideo(video);

    if (decision.ignore) {
      seenVideos.add(video.videoId);
      writeJsonSet(SEEN_YOUTUBE_FILE, seenVideos);

      console.log(`Ignored YouTube video: ${video.title} | reason=${decision.reason}`);
      continue;
    }

    if (alertsSent >= MAX_YOUTUBE_ALERTS_PER_CHECK) {
      console.log(
        `YouTube alert cap reached (${MAX_YOUTUBE_ALERTS_PER_CHECK}). Remaining eligible videos will be processed next check.`
      );
      break;
    }

    // Mark as seen before sending so a crash/rate-limit restart does not spam duplicates.
    // The tradeoff: if Discord fails permanently, this one video may not alert.
    // For this use case, avoiding duplicate spam is more important.
    seenVideos.add(video.videoId);
    writeJsonSet(SEEN_YOUTUBE_FILE, seenVideos);

    await sendYouTubeAlert(video);

    alertsSent += 1;

    console.log(`YouTube alert sent: ${video.title}`);

    // Small spacing to avoid bursty webhook sends.
    await sleep(1250);
  }

  console.log(
    `[${new Date().toISOString()}] Checked YouTube. Returned videos: ${videos.length}. Alerts sent: ${alertsSent}`
  );
}

async function main() {
  console.log("Rejected Draft Twitch + YouTube monitor started.");
  console.log(`Monitoring Twitch game ID: ${TWITCH_GAME_ID}`);
  console.log(`Monitoring YouTube query: ${YOUTUBE_QUERY}`);
  console.log(`YouTube title must contain exact text: ${REQUIRED_YOUTUBE_TITLE_TEXT}`);

  startHealthServer();

  await checkTwitchStreams();

  try {
    await checkYouTubeVideos();
  } catch (err) {
    console.error("Initial YouTube check failed:", err);
  }

  cron.schedule("*/5 * * * *", async () => {
    try {
      await checkTwitchStreams();
    } catch (err) {
      console.error("Scheduled Twitch check failed:", err);
    }
  });

  cron.schedule("0 * * * *", async () => {
    try {
      await checkYouTubeVideos();
    } catch (err) {
      console.error("Scheduled YouTube check failed:", err);
    }
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});