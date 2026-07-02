require("dotenv").config();

const fs = require("fs");
const path = require("path");
const cron = require("node-cron");

const {
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_GAME_ID,
  DISCORD_WEBHOOK,
} = process.env;

const DATA_DIR = path.join(__dirname, "data");
const SEEN_FILE = path.join(DATA_DIR, "seen_streamers.json");
const LIVE_FILE = path.join(DATA_DIR, "currently_live.json");

let twitchToken = null;
let twitchTokenExpiresAt = 0;

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required .env value: ${name}`);
  }
}

requireEnv("TWITCH_CLIENT_ID", TWITCH_CLIENT_ID);
requireEnv("TWITCH_CLIENT_SECRET", TWITCH_CLIENT_SECRET);
requireEnv("TWITCH_GAME_ID", TWITCH_GAME_ID);
requireEnv("DISCORD_WEBHOOK", DISCORD_WEBHOOK);

function ensureFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

  if (!fs.existsSync(SEEN_FILE)) fs.writeFileSync(SEEN_FILE, "[]");
  if (!fs.existsSync(LIVE_FILE)) fs.writeFileSync(LIVE_FILE, "[]");
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

async function getLiveStreams() {
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

async function sendDiscordAlert(stream, isFirstTime) {
  const streamUrl = `https://twitch.tv/${stream.user_login}`;

  const title = isFirstTime
    ? "🚨 New first-time Rejected Draft streamer!"
    : "🔴 Rejected Draft streamer is live again!";

  const description = [
    `**${stream.user_name}** is live now.`,
    "",
    `**Title:** ${stream.title || "No title"}`,
    `**Viewers:** ${stream.viewer_count}`,
    `**Language:** ${stream.language || "Unknown"}`,
    "",
    streamUrl,
  ].join("\n");

  const payload = {
    content: isFirstTime ? "@Dev" : undefined,
    embeds: [
      {
        title,
        description,
        url: streamUrl,
        color: isFirstTime ? 15158332 : 5763719,
        thumbnail: {
          url: stream.thumbnail_url
            .replace("{width}", "320")
            .replace("{height}", "180"),
        },
        fields: [
          {
            name: "Streamer",
            value: stream.user_name,
            inline: true,
          },
          {
            name: "First time?",
            value: isFirstTime ? "Yes ⭐" : "No",
            inline: true,
          },
          {
            name: "Started at",
            value: stream.started_at,
            inline: false,
          },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const res = await fetch(DISCORD_WEBHOOK, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Discord webhook error ${res.status}: ${await res.text()}`);
  }
}

async function checkStreams() {
  ensureFiles();

  const seenStreamers = readJsonSet(SEEN_FILE);
  const currentlyLive = readJsonSet(LIVE_FILE);

  const streams = await getLiveStreams();

  const liveNow = new Set(streams.map((s) => s.user_id));

  for (const stream of streams) {
    const wasAlreadyLive = currentlyLive.has(stream.user_id);

    if (wasAlreadyLive) {
      continue;
    }

    const isFirstTime = !seenStreamers.has(stream.user_id);

    await sendDiscordAlert(stream, isFirstTime);

    seenStreamers.add(stream.user_id);

    console.log(
      `Alert sent: ${stream.user_name} | firstTime=${isFirstTime}`
    );
  }

  writeJsonSet(SEEN_FILE, seenStreamers);
  writeJsonSet(LIVE_FILE, liveNow);

  console.log(
    `[${new Date().toISOString()}] Checked Twitch. Live streams: ${streams.length}`
  );
}

async function main() {
  console.log("Rejected Draft Twitch monitor started.");
  console.log(`Monitoring Twitch game ID: ${TWITCH_GAME_ID}`);

  await checkStreams();

  cron.schedule("*/5 * * * *", async () => {
    try {
      await checkStreams();
    } catch (err) {
      console.error("Scheduled check failed:", err);
    }
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});