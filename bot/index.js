import { mkdir, rm, stat } from "node:fs/promises";
import { createReadStream, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  AttachmentBuilder,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  PermissionsBitField
} from "discord.js";

loadLocalEnv();

const token = process.env.DISCORD_TOKEN;
const channelIds = new Set(splitList(process.env.DISCORD_MEDIA_CHANNEL_IDS));
const linkOnlyChannelIds = new Set(splitList(process.env.DISCORD_LINK_ONLY_CHANNEL_IDS));
const maxVideoBytes = Number.parseInt(process.env.MAX_VIDEO_BYTES || "24000000", 10);
const ytdlpBin = process.env.YTDLP_BIN || "yt-dlp";
const cookiesFile = process.env.YTDLP_COOKIES_FILE || "";
const activeMessages = new Set();

const supportedUrlPattern =
  /https?:\/\/(?:www\.|m\.)?(?:(?:youtube\.com|youtu\.be)\/\S+|(?:tiktok\.com)\/\S+|(?:instagram\.com|instagr\.am)\/\S+)/gi;
const anyUrlPattern = /https?:\/\/\S+/gi;

if (!token) {
  throw new Error("DISCORD_TOKEN is required. Copy .env.example to .env and fill it in.");
}

if (channelIds.size === 0) {
  console.warn("DISCORD_MEDIA_CHANNEL_IDS is empty. The bot will log in but ignore all channels.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

client.once("ready", () => {
  console.log(`hxlftone media bot logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || message.webhookId) return;
  if (!message.guild) return;
  if (activeMessages.has(message.id)) return;

  const botMember = message.guild.members.me || (await message.guild.members.fetchMe());
  const permissions = message.channel.permissionsFor(botMember);

  if (linkOnlyChannelIds.has(message.channelId)) {
    const isAllowed = isLinkOnlyPost(message.content);

    if (!isAllowed) {
      await removeLinkOnlyViolation(message, permissions);
      return;
    }
  }

  if (!channelIds.has(message.channelId)) return;

  const url = firstSupportedUrl(message.content);
  if (!url) return;

  if (!permissions?.has(PermissionsBitField.Flags.SendMessages)) return;
  if (!permissions.has(PermissionsBitField.Flags.AttachFiles)) {
    await safeReply(message, "I can repost videos here, but I need the `Attach Files` permission.");
    return;
  }

  activeMessages.add(message.id);

  let statusMessage;
  let downloaded;

  try {
    statusMessage = await message.reply({
      content: "Processing video...",
      allowedMentions: { repliedUser: false }
    });

    downloaded = await downloadVideo(url);
    const fileSize = (await stat(downloaded.filePath)).size;

    if (fileSize > maxVideoBytes) {
      await statusMessage.edit("That video is too large to repost as a Discord attachment.");
      return;
    }

    const attachment = new AttachmentBuilder(createReadStream(downloaded.filePath), {
      name: downloaded.fileName
    });

    const originalText = stripSupportedUrls(message.content).trim();
    const content = [
      `${message.member?.displayName || message.author.username} shared a video:`,
      originalText ? `> ${truncate(originalText, 1600)}` : ""
    ]
      .filter(Boolean)
      .join("\n");

    await message.channel.send({
      content,
      files: [attachment],
      allowedMentions: { parse: [] }
    });

    if (permissions.has(PermissionsBitField.Flags.ManageMessages)) {
      await message.delete();
      await statusMessage.delete().catch(() => {});
    } else {
      await statusMessage.edit(
        "Reposted. Give me `Manage Messages` if you want me to remove the original link afterward."
      );
    }
  } catch (error) {
    console.error("media repost failed", error);
    if (statusMessage) {
      await statusMessage.edit("I couldn't repost that video. Leaving the original link up.");
    } else {
      await safeReply(message, "I couldn't repost that video. Leaving the original link up.");
    }
  } finally {
    activeMessages.delete(message.id);
    if (downloaded?.workDir) {
      await rm(downloaded.workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

client.login(token);

function firstSupportedUrl(content) {
  supportedUrlPattern.lastIndex = 0;
  const url = supportedUrlPattern.exec(content)?.[0] || "";
  return url.replace(/[>)\].,!?:;]+$/g, "");
}

function isLinkOnlyPost(content) {
  const trimmed = content.trim();
  if (!trimmed) return false;

  anyUrlPattern.lastIndex = 0;
  const urls = [...trimmed.matchAll(anyUrlPattern)].map((match) =>
    match[0].replace(/[>)\].,!?:;]+$/g, "")
  );
  if (urls.length === 0) return false;

  anyUrlPattern.lastIndex = 0;
  const remainder = trimmed.replace(anyUrlPattern, " ");
  return remainder.replace(/[<>()\[\]\s,.;:!?]+/g, "") === "";
}

async function removeLinkOnlyViolation(message, permissions) {
  const embed = new EmbedBuilder()
    .setColor(0x1d1d1f)
    .setTitle("Finished edits is links only")
    .setDescription(
      "Your message was removed because this channel is only for finished edit links. Repost with just the video link and no extra message text."
    )
    .addFields({
      name: "Channel",
      value: `<#${message.channelId}>`
    })
    .setFooter({ text: "hxlftone" })
    .setTimestamp();

  await message.author.send({ embeds: [embed] }).catch(() => {});

  if (permissions?.has(PermissionsBitField.Flags.ManageMessages)) {
    await message.delete().catch(() => {});
  } else if (permissions?.has(PermissionsBitField.Flags.SendMessages)) {
    await safeReply(
      message,
      "This channel is links only, but I need `Manage Messages` to remove non-link messages."
    );
  }
}

function stripSupportedUrls(content) {
  supportedUrlPattern.lastIndex = 0;
  return content.replace(supportedUrlPattern, "").replace(/\s+/g, " ");
}

async function downloadVideo(url) {
  const workDir = await makeWorkDir();
  const outputTemplate = path.join(workDir, "%(extractor)s-%(id)s.%(ext)s");
  const args = [
    "--no-playlist",
    "--no-progress",
    "--max-filesize",
    String(maxVideoBytes),
    "--merge-output-format",
    "mp4",
    "-f",
    "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
    "-o",
    outputTemplate,
    "--print",
    "after_move:filepath",
    url
  ];

  if (cookiesFile) {
    args.splice(0, 0, "--cookies", cookiesFile);
  }

  const { stdout } = await run(ytdlpBin, args, { cwd: workDir, timeoutMs: 90_000 });
  const filePath = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);

  if (!filePath) {
    throw new Error("yt-dlp did not report an output file.");
  }

  return {
    workDir,
    filePath,
    fileName: sanitizeFileName(path.basename(filePath))
  };
}

async function makeWorkDir() {
  const dir = path.join(tmpdir(), `hxlftone-media-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks = [];
    const errors = [];
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out.`));
    }, options.timeoutMs || 30_000);

    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const stdout = Buffer.concat(chunks).toString("utf8");
      const stderr = Buffer.concat(errors).toString("utf8");
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with ${code}: ${stderr || stdout}`));
      }
    });
  });
}

async function safeReply(message, content) {
  try {
    await message.reply({ content, allowedMentions: { repliedUser: false } });
  } catch {
    // Nothing useful to do if the channel rejects the reply.
  }
}

function truncate(value, maxLength) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}

function sanitizeFileName(fileName) {
  return fileName.replace(/[^\w.-]+/g, "_").slice(0, 120) || "video.mp4";
}

function splitList(value = "") {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function loadLocalEnv() {
  try {
    const envPath = path.resolve(".env");
    const raw = readFileSync(envPath);
    for (const line of raw.toString("utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator === -1) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional.
  }
}
