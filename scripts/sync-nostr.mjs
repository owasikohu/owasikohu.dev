import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { nip19 } from "nostr-tools";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { verifyEvent } from "nostr-tools/pure";
import WebSocket from "ws";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const CONFIG_PATH = path.join(PROJECT_ROOT, "data", "nostr.json");
const STATE_PATH = path.join(PROJECT_ROOT, "data", "nostr-state.json");
const BLOG_ROOT = path.join(PROJECT_ROOT, "content", "blog");
const OUTPUT_DIRECTORY = path.join(BLOG_ROOT, "generated");
const TEMP_DIRECTORY = path.join(BLOG_ROOT, ".generated-temp");
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 10_000;
const RELAY_TIMEOUT_MS = 12_000;

const EMOJI_BY_TAG = new Map([
  ["nostr", "📡"],
  ["test", "📝"],
  ["ctf", "🚩"],
  ["security", "🔒"],
  ["web", "🌐"],
  ["ai", "💡"],
  ["audio", "🎵"],
  ["programming", "💻"],
]);
const EMOJI_PALETTE = ["📡", "📝", "🔧", "💾", "🌐", "⚡", "🎵", "💡", "🔒", "💻"];

useWebSocketImplementation(WebSocket);

function eventTag(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1]?.trim() ?? "";
}

function eventIdentifier(event) {
  return event.tags.find((tag) => tag[0] === "d")?.[1] ?? "";
}

function eventTags(event, name) {
  const seen = new Set();
  return event.tags
    .filter((tag) => tag[0] === name)
    .map((tag) => tag[1]?.trim().replace(/^#+/, ""))
    .filter((tag) => {
      if (!tag) return false;
      const key = tag.toLocaleLowerCase("ja");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function stableSlug(identifier) {
  if (/^[a-z0-9][a-z0-9._~-]*$/i.test(identifier)) return identifier;
  return `post-${createHash("sha256").update(identifier).digest("hex").slice(0, 12)}`;
}

function selectThumbnail(identifier, tags) {
  for (const tag of tags) {
    const emoji = EMOJI_BY_TAG.get(tag.toLocaleLowerCase("en-US"));
    if (emoji) return emoji;
  }
  const byte = Number.parseInt(createHash("sha256").update(identifier).digest("hex").slice(0, 2), 16);
  return EMOJI_PALETTE[byte % EMOJI_PALETTE.length];
}

function timestampToIso(value, fallback) {
  const timestamp = Number.parseInt(value, 10);
  const safeTimestamp = Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : fallback;
  return new Date(safeTimestamp * 1000).toISOString();
}

function makeSummary(content) {
  return content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#~-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function removeDuplicateLeadingTitle(content, title) {
  const match = content.match(/^#\s+(.+?)\s*(?:\r?\n)+/);
  if (match?.[1].trim() === title.trim()) return content.slice(match[0].length);
  return content;
}

export function detectImage(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

async function readLimitedBody(response) {
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
  if (declaredLength > MAX_IMAGE_BYTES) throw new Error("image exceeds size limit");

  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) throw new Error("image exceeds size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function downloadImage(source, articleDirectory, cache) {
  if (!source) return null;
  if (cache.has(source)) return cache.get(source);

  try {
    const url = new URL(source);
    if (url.protocol !== "https:") throw new Error("only HTTPS images are accepted");

    const response = await fetch(url, {
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif" },
      redirect: "follow",
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (new URL(response.url).protocol !== "https:") throw new Error("image redirected away from HTTPS");

    const buffer = await readLimitedBody(response);
    const extension = detectImage(buffer);
    if (!extension) throw new Error("unsupported or invalid image format");

    const filename = `${createHash("sha256").update(buffer).digest("hex").slice(0, 20)}.${extension}`;
    const relativePath = path.posix.join("media", filename);
    await mkdir(path.join(articleDirectory, "media"), { recursive: true });
    await writeFile(path.join(articleDirectory, relativePath), buffer);
    cache.set(source, relativePath);
    return relativePath;
  } catch (error) {
    console.warn(`[nostr] image skipped: ${source} (${error.message})`);
    cache.set(source, null);
    return null;
  }
}

export async function localizeMarkdownImages(content, articleDirectory, cache) {
  const pattern = /!\[([^\]]*)\]\(\s*(https:\/\/[^\s)]+)(?:\s+["'][^)]*["'])?\s*\)/gi;
  const matches = [...content.matchAll(pattern)];
  const replacements = [];

  for (const match of matches) {
    const [original, alt, source] = match;
    const localPath = await downloadImage(source, articleDirectory, cache);
    const replacement = localPath ? `![${alt}](${localPath})` : `[${alt || "画像"}](${source})`;
    replacements.push({ start: match.index, end: match.index + original.length, replacement });
  }

  for (const item of replacements.reverse()) {
    content = content.slice(0, item.start) + item.replacement + content.slice(item.end);
  }
  return content;
}

function validArticlesFromRelay(events, authorHex) {
  return events.filter(
    (event) => event.kind === 30023
      && event.pubkey === authorHex
      && eventIdentifier(event)
      && verifyEvent(event),
  );
}

async function fetchArticlesFromRelay(relay, authorHex, attempts) {
  const collected = new Map();
  const errors = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const pool = new SimplePool();
    try {
      const events = await pool.querySync(
        [relay],
        { kinds: [30023], authors: [authorHex] },
        { maxWait: RELAY_TIMEOUT_MS },
      );
      const validEvents = validArticlesFromRelay(events, authorHex);
      for (const event of validEvents) collected.set(event.id, event);
      console.log(`[nostr] ${relay} attempt ${attempt}: ${validEvents.length} valid article(s)`);
    } catch (error) {
      errors.push(error.message);
      console.warn(`[nostr] ${relay} attempt ${attempt} failed: ${error.message}`);
    } finally {
      pool.close([relay]);
    }
  }

  if (collected.size === 0) {
    const detail = errors.length > 0 ? ` (${errors.join("; ")})` : "";
    throw new Error(`${relay} returned no valid articles${detail}`);
  }

  return [...collected.values()];
}

async function fetchArticles(config, authorHex) {
  const attempts = Number.isSafeInteger(config.queryAttempts) && config.queryAttempts > 0
    ? config.queryAttempts
    : 2;
  const minimumSuccessfulRelays = Number.isSafeInteger(config.minimumSuccessfulRelays)
    ? config.minimumSuccessfulRelays
    : Math.min(2, config.relays.length);

  if (minimumSuccessfulRelays < 1 || minimumSuccessfulRelays > config.relays.length) {
    throw new Error("minimumSuccessfulRelays must be between 1 and the number of relays");
  }

  const results = await Promise.allSettled(
    config.relays.map((relay) => fetchArticlesFromRelay(relay, authorHex, attempts)),
  );
  const successful = results.filter((result) => result.status === "fulfilled");

  results.forEach((result, index) => {
    if (result.status === "rejected") console.warn(`[nostr] relay unavailable: ${config.relays[index]} (${result.reason.message})`);
  });

  if (successful.length < minimumSuccessfulRelays) {
    throw new Error(
      `only ${successful.length}/${config.relays.length} relays returned valid articles; `
      + `${minimumSuccessfulRelays} required to prevent an incomplete deployment`,
    );
  }

  const collected = new Map();
  for (const result of successful) {
    for (const event of result.value) collected.set(event.id, event);
  }
  console.log(`[nostr] merged ${collected.size} event(s) from ${successful.length}/${config.relays.length} relays`);
  return [...collected.values()];
}

function latestAddressableEvents(events, authorHex) {
  const latest = new Map();
  for (const event of events) {
    if (event.kind !== 30023 || event.pubkey !== authorHex || !verifyEvent(event)) continue;
    const identifier = eventIdentifier(event);
    if (!identifier) continue;
    const previous = latest.get(identifier);
    if (!previous || event.created_at > previous.created_at) latest.set(identifier, event);
  }
  return [...latest.values()].sort((a, b) => b.created_at - a.created_at);
}

async function readState(authorHex) {
  let state;
  try {
    state = JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`could not read ${path.relative(PROJECT_ROOT, STATE_PATH)}: ${error.message}`);
  }

  if (state.version !== 1 || state.author !== authorHex || !Array.isArray(state.articles)) {
    throw new Error(`${path.relative(PROJECT_ROOT, STATE_PATH)} is invalid or belongs to another author`);
  }
  for (const article of state.articles) {
    if (!article
      || typeof article.identifier !== "string"
      || typeof article.event_id !== "string"
      || !Number.isSafeInteger(article.created_at)) {
      throw new Error(`${path.relative(PROJECT_ROOT, STATE_PATH)} contains an invalid article`);
    }
  }
  return state;
}

function assertStateCoverage(articles, state) {
  if (!state) return;

  const current = new Map(articles.map((article) => [eventIdentifier(article), article]));
  const missing = state.articles.filter((expected) => {
    const article = current.get(expected.identifier);
    if (!article) return true;
    if (article.created_at > expected.created_at) return false;
    return article.created_at !== expected.created_at || article.id !== expected.event_id;
  });

  if (missing.length > 0) {
    const identifiers = missing.map((article) => article.identifier).join(", ");
    throw new Error(
      `relay results are missing ${missing.length} monitored article(s): ${identifiers}; keeping the current deployment`,
    );
  }
}

async function writeState(articles, authorHex) {
  const state = {
    version: 1,
    author: authorHex,
    articles: articles
      .map((article) => ({
        identifier: eventIdentifier(article),
        event_id: article.id,
        created_at: article.created_at,
      }))
      .sort((a, b) => a.identifier.localeCompare(b.identifier, "en")),
  };
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function writeArticle(event, config, authorHex, usedSlugs) {
  const identifier = eventIdentifier(event);
  const slug = stableSlug(identifier);
  if (usedSlugs.has(slug)) throw new Error(`two article identifiers resolve to the same slug: ${slug}`);
  usedSlugs.add(slug);

  const articleDirectory = path.join(TEMP_DIRECTORY, slug);
  await mkdir(articleDirectory, { recursive: true });
  const imageCache = new Map();
  const tags = eventTags(event, "t");
  const title = eventTag(event, "title") || identifier;
  const summary = eventTag(event, "summary") || makeSummary(event.content);
  const hero = await downloadImage(eventTag(event, "image"), articleDirectory, imageCache);
  const articleContent = removeDuplicateLeadingTitle(event.content, title);
  const content = await localizeMarkdownImages(articleContent, articleDirectory, imageCache);
  const publishedAt = timestampToIso(eventTag(event, "published_at"), event.created_at);
  const updatedAt = timestampToIso(String(event.created_at), event.created_at);
  const naddr = nip19.naddrEncode({
    kind: 30023,
    pubkey: authorHex,
    identifier,
    relays: config.relays,
  });

  const frontMatter = {
    title,
    slug,
    url: `/blog/${slug}/`,
    date: publishedAt,
    lastmod: updatedAt,
    summary,
    blog_tags: tags,
    thumbnail: selectThumbnail(identifier, tags),
    hero,
    nostr_event_id: event.id,
    nostr_identifier: identifier,
    nostr_uri: `nostr:${naddr}`,
    nostr_url: `https://primal.net/a/${naddr}`,
    generated_from_nostr: true,
    draft: false,
  };

  await writeFile(
    path.join(articleDirectory, "index.md"),
    `${JSON.stringify(frontMatter, null, 2)}\n\n${content.trim()}\n`,
    "utf8",
  );
}

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  if (!Array.isArray(config.relays) || config.relays.length === 0) throw new Error("at least one relay is required");

  const decoded = nip19.decode(config.author);
  if (decoded.type !== "npub" || typeof decoded.data !== "string") throw new Error("data/nostr.json author must be an npub");

  const events = await fetchArticles(config, decoded.data);
  const articles = latestAddressableEvents(events, decoded.data);
  if (articles.length === 0) throw new Error("no valid NIP-23 articles were returned; keeping the current deployment");
  const state = await readState(decoded.data);
  assertStateCoverage(articles, state);

  await rm(TEMP_DIRECTORY, { recursive: true, force: true });
  await mkdir(TEMP_DIRECTORY, { recursive: true });
  const usedSlugs = new Set();
  for (const article of articles) await writeArticle(article, config, decoded.data, usedSlugs);

  await rm(OUTPUT_DIRECTORY, { recursive: true, force: true });
  await rename(TEMP_DIRECTORY, OUTPUT_DIRECTORY);
  if (process.argv.includes("--update-state")) {
    await writeState(articles, decoded.data);
    console.log(`[nostr] updated ${path.relative(PROJECT_ROOT, STATE_PATH)}`);
  }
  console.log(`[nostr] generated ${articles.length} article${articles.length === 1 ? "" : "s"} from ${config.relays.length} relays`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[nostr] sync failed: ${error.message}`);
    process.exitCode = 1;
  });
}
