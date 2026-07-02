require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");

const {
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_GAME_ID,
  DISCORD_WEBHOOK,

  YOUTUBE_API_KEY,
  YOUTUBE_SEARCH_QUERY,
  YOUTUBE_MIN_DATE,
  YOUTUBE_CHECK_INTERVAL_MINUTES,

  TICK_SECRET,
  PORT,
} = process.env;

const DATA_DIR = path.join(__dirname, "data");

const SEEN_TWITCH_FILE = path.join(DATA_DIR, "seen_streamers.json");
const LIVE_TWITCH_FILE = path.join(DATA_DIR, "currently_live.json");
const SEEN_YOUTUBE_FILE = path.join(DATA_DIR, "seen_youtube_videos.json");
const LAST_YOUTUBE_CHECK_FILE = path.join(DATA_DIR, "last_youtube_check.json");

const REQUIRED_YOUTUBE_TITLE_TEXT = "Rejected Draft";
const YOUTUBE_QUERY = YOUTUBE_SEARCH_QUERY || "\"Rejected Draft\"";
const YOUTUBE_MIN_DATE_VALUE = new Date(
  YOUTUBE_MIN_DATE || "2026-06-24T00:00:00.000Z"
);

const YOUTUBE_CHECK_INTERVAL_MINUTES_VALUE = Number(
  YOUTUBE_CHECK_INTERVAL_MINUTES || 45
);

const MAX_YOUTUBE_DIGEST_VIDEOS = 10;
const DISPLAY_TIME_ZONE = "America/Los_Angeles";

let twitchToken = null;
let twitchTokenExpiresAt = 0;
let tickInProgress = false;

let status = {
  startedAt: new Date().toISOString(),
  lastTickStartedAt: null,
  lastTickFinishedAt: null,
  lastTickSource: null,
  lastTickError: null,
  lastTwitchCheckAt: null,
  lastYouTubeCheckAt: null,
  lastYouTubeDigestCount: 0,
  lastDiscordStatus: null,
  lastDiscordBody: null,
};

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required env value: ${name}`);
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

  if (!fs.existsSync(LAST_YOUTUBE_CHECK_FILE)) {
    fs.writeFileSync(
      LAST_YOUTUBE_CHECK_FILE,
      JSON.stringify({ lastCheckedAt: null }, null, 2)
    );
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

function readJsonObject(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonObject(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function decodeHtmlEntities(text) {
  if (!text) return "";

  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function escapeDiscordMarkdown(text) {
  if (!text) return "";

  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/~/g, "\\~")
    .replace(/`/g, "\\`")
    .replace(/\|/g, "\\|");
}

function formatDateForHumans(isoString) {
  if (!isoString) return "Unknown";

  const date = new Date(isoString);

  if (Number.isNaN(date.getTime())) {
    return isoString;
  }

  return new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function getWebhookDebugLabel() {
  try {
    const url = new URL(DISCORD_WEBHOOK);
    const parts = url.pathname.split("/");
    const webhookId = parts[3] || "unknown";

    if (url.hostname.includes("pipedream")) {
      return `relay=pipedream webhook_id=${webhookId}`;
    }

    if (url.hostname.includes("discord")) {
      return `relay=direct-discord webhook_id=${webhookId}`;
    }

    return `relay=${url.hostname} webhook_id=${webhookId}`;
  } catch {
    return "webhook_id=invalid_url";
  }
}

function logDiscordResponse(context, res, bodyText) {
  status.lastDiscordStatus = res.status;
  status.lastDiscordBody = bodyText ? bodyText.slice(0, 500) : "";

  console.log(`${context}: Discord relay status=${res.status}`);
  console.log(`${context}: ${getWebhookDebugLabel()}`);
  console.log(`${context}: x-ratelimit-limit=${res.headers.get("x-ratelimit-limit")}`);
  console.log(`${context}: x-ratelimit-remaining=${res.headers.get("x-ratelimit-remaining")}`);
  console.log(`${context}: x-ratelimit-reset-after=${res.headers.get("x-ratelimit-reset-after")}`);
  console.log(`${context}: retry-after=${res.headers.get("retry-after")}`);

  if (bodyText) {
    console.log(`${context}: body=${bodyText.slice(0, 500)}`);
  }
}

async function sendDiscordPayload(payload, context = "Discord alert") {
  console.log(`${context}: sending Discord payload.`);
  console.log(`${context}: ${getWebhookDebugLabel()}`);

  const res = await fetch(DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const bodyText = await res.text();
  logDiscordResponse(context, res, bodyText);

  if (res.ok) {
    console.log(`${context}: send succeeded.`);
    return true;
  }

  if (res.status === 429) {
    console.warn(`${context}: rate limited. Skipping alert instead of freezing.`);
    return false;
  }

  throw new Error(`${context} error ${res.status}: ${bodyText}`);
}

async function sendDiscordEmbed(embed, context = "Discord embed alert") {
  return sendDiscordPayload({ embeds: [embed] }, context);
}

async function sendDiscordContent(content, context = "Discord content alert") {
  return sendDiscordPayload({ content }, context);
}

function startHealthServer() {
  const port = PORT || 3000;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/test-discord") {
      if (TICK_SECRET && url.searchParams.get("secret") !== TICK_SECRET) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
        return;
      }

      sendDiscordContent(
        `Discord relay test from Render at ${formatDateForHumans(new Date().toISOString())}`,
        "Minimal Discord relay test"
      )
        .then((ok) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(
              {
                ok,
                webhookDebug: getWebhookDebugLabel(),
                lastDiscordStatus: status.lastDiscordStatus,
                lastDiscordBody: status.lastDiscordBody,
              },
              null,
              2
            )
          );
        })
        .catch((err) => {
          console.error("Minimal Discord relay test failed:", err);

          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(
              {
                ok: false,
                error: String(err && err.stack ? err.stack : err),
                webhookDebug: getWebhookDebugLabel(),
              },
              null,
              2
            )
          );
        });

      return;
    }

    if (url.pathname === "/tick") {
      if (TICK_SECRET && url.searchParams.get("secret") !== TICK_SECRET) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
        return;
      }

      if (tickInProgress) {
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            {
              ok: true,
              alreadyRunning: true,
              status,
            },
            null,
            2
          )
        );
        return;
      }

      runTick("http /tick").catch((err) => {
        console.error("Tick failed:", err);
      });

      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, started: true }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          ok: true,
          message: "Rejected Draft Twitch + YouTube monitor is running.",
          usage: {
            tick: "/tick?secret=YOUR_TICK_SECRET",
            testDiscord: "/test-discord?secret=YOUR_TICK_SECRET",
          },
          webhookDebug: getWebhookDebugLabel(),
          status,
        },
        null,
        2
      )
    );
  });

  server.listen(port, () => {
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

async function sendTwitchAlert(stream, isFirstTime) {
  const streamUrl = `https://twitch.tv/${stream.user_login}`;
  const safeTitle = escapeDiscordMarkdown(stream.title || "No title");
  const startedAt = formatDateForHumans(stream.started_at);

  const headline = isFirstTime
    ? "🚨 New creator streaming Rejected Draft"
    : "🔴 Rejected Draft is live on Twitch";

  const description = [
    `**[${escapeDiscordMarkdown(stream.user_name)}](${streamUrl})** is live now.`,
    "",
    `**Stream title:** ${safeTitle}`,
    "",
    `[Watch on Twitch](${streamUrl})`,
  ].join("\n");

  return sendDiscordEmbed(
    {
      title: headline,
      description,
      color: isFirstTime ? 15158332 : 5763719,
      thumbnail: stream.thumbnail_url
        ? {
            url: stream.thumbnail_url
              .replace("{width}", "320")
              .replace("{height}", "180"),
          }
        : undefined,
      fields: [
        {
          name: "Status",
          value: isFirstTime ? "First time detected ⭐" : "Returning streamer",
          inline: true,
        },
        {
          name: "Viewers",
          value: String(stream.viewer_count ?? "Unknown"),
          inline: true,
        },
        {
          name: "Language",
          value: stream.language || "Unknown",
          inline: true,
        },
        {
          name: "Started",
          value: startedAt,
          inline: false,
        },
      ],
      footer: {
        text: "Rejected Draft stream monitor",
      },
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

    const sent = await sendTwitchAlert(stream, isFirstTime);

    seenStreamers.add(stream.user_id);
    writeJsonSet(SEEN_TWITCH_FILE, seenStreamers);

    console.log(
      `Twitch alert attempted: ${stream.user_name} | firstTime=${isFirstTime} | sent=${sent}`
    );
  }

  writeJsonSet(LIVE_TWITCH_FILE, liveNow);

  status.lastTwitchCheckAt = new Date().toISOString();

  console.log(
    `[${new Date().toISOString()}] Checked Twitch. Live streams: ${streams.length}`
  );
}

function dedupeVideos(videos) {
  const byId = new Map();

  for (const video of videos) {
    if (!video.videoId) continue;
    if (!byId.has(video.videoId)) byId.set(video.videoId, video);
  }

  return [...byId.values()];
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
    publishedAfter: YOUTUBE_MIN_DATE_VALUE.toISOString(),
    key: YOUTUBE_API_KEY,
  });

  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);

  if (!res.ok) {
    throw new Error(`YouTube API search error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();

  const videos = (data.items || [])
    .filter((item) => item.id && item.id.videoId && item.snippet)
    .map((item) => ({
      videoId: item.id.videoId,
      title: decodeHtmlEntities(item.snippet.title || ""),
      channelTitle: decodeHtmlEntities(item.snippet.channelTitle || "Unknown channel"),
      publishedAt: item.snippet.publishedAt,
      thumbnail:
        item.snippet.thumbnails?.medium?.url ||
        item.snippet.thumbnails?.default?.url ||
        null,
      source: "youtube-search",
    }));

  console.log(`YouTube API search returned ${videos.length} videos.`);

  return dedupeVideos(videos);
}

function shouldIgnoreYouTubeVideo(video) {
  const publishedDate = new Date(video.publishedAt);

  if (Number.isNaN(publishedDate.getTime())) {
    return {
      ignore: true,
      reason: "invalid publish date",
    };
  }

  if (publishedDate < YOUTUBE_MIN_DATE_VALUE) {
    return {
      ignore: true,
      reason: `before ${YOUTUBE_MIN_DATE_VALUE.toISOString()}`,
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

function formatSingleYouTubeDescription(video) {
  const url = `https://www.youtube.com/watch?v=${video.videoId}`;
  const safeTitle = escapeDiscordMarkdown(video.title);
  const safeChannel = escapeDiscordMarkdown(video.channelTitle);
  const published = formatDateForHumans(video.publishedAt);

  return [
    `**[${safeTitle}](${url})**`,
    "",
    `**Channel:** ${safeChannel}`,
    `**Published:** ${published}`,
    "",
    `[Watch on YouTube](${url})`,
  ].join("\n");
}

function formatMultiYouTubeDigestDescription(videos) {
  const includedVideos = videos.slice(0, MAX_YOUTUBE_DIGEST_VIDEOS);
  const lines = [];

  lines.push(
    `Found **${videos.length}** new Rejected Draft YouTube video${videos.length === 1 ? "" : "s"} since the last check.`
  );
  lines.push("");

  for (const [index, video] of includedVideos.entries()) {
    const url = `https://www.youtube.com/watch?v=${video.videoId}`;
    const safeTitle = escapeDiscordMarkdown(video.title);
    const safeChannel = escapeDiscordMarkdown(video.channelTitle);
    const published = formatDateForHumans(video.publishedAt);

    lines.push(`**${index + 1}. [${safeTitle}](${url})**`);
    lines.push(`Channel: ${safeChannel}`);
    lines.push(`Published: ${published}`);
    lines.push("");
  }

  if (videos.length > includedVideos.length) {
    lines.push(`Plus ${videos.length - includedVideos.length} more video(s) not shown.`);
  }

  let description = lines.join("\n");

  if (description.length > 3900) {
    description =
      description.slice(0, 3850) +
      "\n\n...Digest truncated because Discord embed text is too long.";
  }

  return description;
}

async function sendYouTubeDigestAlert(videos) {
  if (videos.length === 0) return false;

  const newestVideo = videos[videos.length - 1];

  const isSingleVideo = videos.length === 1;

  const embed = isSingleVideo
    ? {
        title: "📺 New Rejected Draft YouTube video",
        description: formatSingleYouTubeDescription(videos[0]),
        color: 16711680,
        thumbnail: videos[0].thumbnail ? { url: videos[0].thumbnail } : undefined,
        footer: {
          text: "Rejected Draft YouTube monitor",
        },
        timestamp: new Date().toISOString(),
      }
    : {
        title: `📺 ${videos.length} new Rejected Draft YouTube videos`,
        description: formatMultiYouTubeDigestDescription(videos),
        color: 16711680,
        thumbnail: newestVideo.thumbnail ? { url: newestVideo.thumbnail } : undefined,
        footer: {
          text: "Rejected Draft YouTube monitor",
        },
        timestamp: new Date().toISOString(),
      };

  return sendDiscordEmbed(embed, "YouTube digest Discord alert");
}

function shouldCheckYouTubeNow() {
  ensureFiles();

  const state = readJsonObject(LAST_YOUTUBE_CHECK_FILE, {
    lastCheckedAt: null,
  });

  if (!state.lastCheckedAt) return true;

  const last = new Date(state.lastCheckedAt);
  if (Number.isNaN(last.getTime())) return true;

  const minutesSinceLastCheck = (Date.now() - last.getTime()) / 60_000;

  return minutesSinceLastCheck >= YOUTUBE_CHECK_INTERVAL_MINUTES_VALUE;
}

function markYouTubeCheckedNow() {
  writeJsonObject(LAST_YOUTUBE_CHECK_FILE, {
    lastCheckedAt: new Date().toISOString(),
  });
}

async function checkYouTubeVideos() {
  ensureFiles();

  const seenVideos = readJsonSet(SEEN_YOUTUBE_FILE);
  const videos = await getRecentYouTubeVideos();

  const newEligibleVideos = [];

  let ignored = 0;
  let alreadySeen = 0;

  // Oldest first, so the digest is chronological.
  for (const video of videos.reverse()) {
    if (seenVideos.has(video.videoId)) {
      alreadySeen += 1;
      continue;
    }

    const decision = shouldIgnoreYouTubeVideo(video);

    if (decision.ignore) {
      seenVideos.add(video.videoId);
      writeJsonSet(SEEN_YOUTUBE_FILE, seenVideos);

      ignored += 1;

      console.log(`Ignored YouTube video: ${video.title} | reason=${decision.reason}`);
      continue;
    }

    newEligibleVideos.push(video);
  }

  let digestSent = false;

  if (newEligibleVideos.length > 0) {
    digestSent = await sendYouTubeDigestAlert(newEligibleVideos);

    for (const video of newEligibleVideos) {
      seenVideos.add(video.videoId);
    }

    writeJsonSet(SEEN_YOUTUBE_FILE, seenVideos);

    if (digestSent) {
      console.log(`YouTube digest sent with ${newEligibleVideos.length} video(s).`);
    } else {
      console.warn(
        `YouTube digest was not sent, but ${newEligibleVideos.length} video(s) were marked seen to avoid repeat spam.`
      );
    }
  } else {
    console.log("No new eligible YouTube videos. No Discord message sent.");
  }

  markYouTubeCheckedNow();

  status.lastYouTubeCheckAt = new Date().toISOString();
  status.lastYouTubeDigestCount = newEligibleVideos.length;

  console.log(
    `[${new Date().toISOString()}] Checked YouTube. Returned: ${videos.length}. New eligible: ${newEligibleVideos.length}. Ignored: ${ignored}. Already seen: ${alreadySeen}.`
  );
}

async function runTick(source) {
  if (tickInProgress) {
    console.log("Tick skipped because another tick is already running.");
    return;
  }

  tickInProgress = true;

  status.lastTickStartedAt = new Date().toISOString();
  status.lastTickSource = source;
  status.lastTickError = null;

  console.log(`[${status.lastTickStartedAt}] Tick started from ${source}.`);

  try {
    await checkTwitchStreams();

    if (shouldCheckYouTubeNow()) {
      await checkYouTubeVideos();
    } else {
      console.log(
        `Skipping YouTube check. Interval is ${YOUTUBE_CHECK_INTERVAL_MINUTES_VALUE} minutes.`
      );
    }

    status.lastTickFinishedAt = new Date().toISOString();

    console.log(`[${status.lastTickFinishedAt}] Tick finished.`);
  } catch (err) {
    status.lastTickError = String(err && err.stack ? err.stack : err);
    status.lastTickFinishedAt = new Date().toISOString();

    console.error("Tick failed:", err);
  } finally {
    tickInProgress = false;
  }
}

async function main() {
  ensureFiles();

  console.log("Rejected Draft Twitch + YouTube monitor started.");
  console.log(`Discord webhook debug: ${getWebhookDebugLabel()}`);
  console.log(`Monitoring Twitch game ID: ${TWITCH_GAME_ID}`);
  console.log(`Monitoring YouTube query: ${YOUTUBE_QUERY}`);
  console.log(`YouTube min date: ${YOUTUBE_MIN_DATE_VALUE.toISOString()}`);
  console.log(`YouTube title must contain exact text: ${REQUIRED_YOUTUBE_TITLE_TEXT}`);
  console.log(`YouTube check interval minutes: ${YOUTUBE_CHECK_INTERVAL_MINUTES_VALUE}`);

  startHealthServer();

  runTick("startup").catch((err) => {
    console.error("Startup tick failed:", err);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});