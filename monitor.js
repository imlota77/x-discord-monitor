const { chromium } = require('playwright');
const fs = require('fs');

const ACCOUNTS = ['realDonaldTrump', 'i1ota', 'elonmusk', 'TruthTrumpPost', 'JeffDean', 'DeItaone', 'unusual_whales', 'aleabitoreddit'];
const YOUTUBE_CHANNELS = ['yutinghaofinance'];
const STATE_FILE = 'state.json';

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const YT_DISCORD_WEBHOOK = process.env.YT_DISCORD_WEBHOOK_URL || DISCORD_WEBHOOK;
const AUTH_TOKEN = process.env.X_AUTH_TOKEN;
const CT0 = process.env.X_CT0;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function isMostlyChinese(text) {
  const cjk = text.match(/[一-鿿]/g) || [];
  const letters = text.match(/[\p{L}]/gu) || [];
  return letters.length > 0 && cjk.length / letters.length > 0.5;
}

async function translateViaGoogle(text) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-TW&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data[0].map(seg => seg[0]).join('');
}

async function translateViaMyMemory(text) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|zh-TW`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.responseData || !data.responseData.translatedText) throw new Error('no translation in response');
  return data.responseData.translatedText;
}

async function translateToZhTW(text) {
  // Google's unofficial endpoint occasionally gets rate-limited when hit
  // repeatedly in a short window (e.g. many accounts translated back to
  // back within one run) — retry once, then fall back to MyMemory (which
  // only accepts shorter text) before giving up.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await translateViaGoogle(text);
    } catch (err) {
      console.error(`Google translate attempt ${attempt + 1} failed:`, err.message);
      if (attempt === 0) await new Promise(r => setTimeout(r, 1500));
    }
  }
  if (text.length <= 480) {
    try {
      return await translateViaMyMemory(text);
    } catch (err) {
      console.error('MyMemory fallback failed:', err.message);
    }
  }
  return '（翻譯失敗，請見原文或點連結查看）';
}

async function sendDiscord(content, webhook = DISCORD_WEBHOOK) {
  await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
}

async function sendDiscordLong(content, webhook = DISCORD_WEBHOOK) {
  const LIMIT = 1900; // stay under Discord's 2000-char message cap
  if (content.length <= LIMIT) {
    await sendDiscord(content, webhook);
    return;
  }
  let remaining = content;
  while (remaining.length > 0) {
    if (remaining.length <= LIMIT) {
      await sendDiscord(remaining, webhook);
      break;
    }
    let cut = remaining.lastIndexOf('\n', LIMIT);
    if (cut < LIMIT * 0.5) cut = LIMIT; // no good line break — hard cut
    await sendDiscord(remaining.slice(0, cut), webhook);
    remaining = remaining.slice(cut).replace(/^\n+/, '');
    await new Promise(r => setTimeout(r, 300));
  }
}

// X collapses long posts behind a "Show more" link in the timeline view —
// the timeline DOM only ever contains the truncated preview text, never the
// full post. To get the complete content we have to open the individual
// status page, which always renders the full, untruncated text.
async function fetchFullPostText(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  return page.evaluate(() => {
    const article = document.querySelector('article');
    if (!article) return { text: '', quoted: null };
    const nested = article.querySelector('article');
    const textEls = Array.from(article.querySelectorAll('[data-testid="tweetText"]'));
    const ownTextEl = nested ? textEls.find(el => !nested.contains(el)) : textEls[0];
    const text = ownTextEl ? ownTextEl.innerText : '';
    let quoted = null;
    if (nested) {
      const qTextEl = nested.querySelector('[data-testid="tweetText"]');
      const qLink = nested.querySelector('a[href*="/status/"]');
      const qHandle = qLink ? qLink.href.split('/status/')[0].split('/').filter(Boolean).pop() : null;
      quoted = { author: qHandle, text: qTextEl ? qTextEl.innerText : '' };
    }
    return { text, quoted };
  });
}

async function checkAccount(page, handle, state) {
  await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // Only look at top-level timeline cells (cellInnerDiv) and take each cell's
  // OUTER article — this excludes nested articles from quote-tweets/embeds,
  // and querySelector('article') always returns the outer one first since it
  // appears earlier in document order than anything nested inside it.
  const posts = await page.$$eval('[data-testid="cellInnerDiv"]', (cells, handle) => {
    return cells.map(cell => {
      const article = cell.querySelector('article');
      if (!article) return null;
      const statusLink = article.querySelector(`a[href*="/${handle}/status/"]`);
      if (!statusLink) return null; // not authored by this handle (e.g. a plain repost)
      const id = statusLink.href.split('/status/')[1]?.split(/[/?]/)[0];
      if (!id) return null;

      // A quote-tweet embeds the quoted post as a nested <article>. Grab the
      // account's own commentary text (any tweetText NOT inside that nested
      // article) separately from the quoted post's own text + author, so
      // callers can include the full quoted content, not just the comment.
      const nested = article.querySelector('article');
      const textEls = Array.from(article.querySelectorAll('[data-testid="tweetText"]'));
      const ownTextEl = nested ? textEls.find(el => !nested.contains(el)) : textEls[0];
      const text = ownTextEl ? ownTextEl.innerText : '';

      let quoted = null;
      if (nested) {
        const qTextEl = nested.querySelector('[data-testid="tweetText"]');
        const qLink = nested.querySelector('a[href*="/status/"]');
        const qHandle = qLink ? qLink.href.split('/status/')[0].split('/').filter(Boolean).pop() : null;
        quoted = { author: qHandle, text: qTextEl ? qTextEl.innerText : '' };
      }

      return { id, url: `https://x.com/${handle}/status/${id}`, text, quoted };
    }).filter(Boolean);
  }, handle);

  if (posts.length === 0) {
    const title = await page.title();
    const bodySnippet = await page.evaluate(() => document.body.innerText.slice(0, 300));
    console.log(`${handle}: no posts found. title="${title}" bodySnippet="${bodySnippet.replace(/\n/g, ' ')}"`);
    return;
  }

  const seen = new Set();
  const uniquePosts = posts.filter(p => (seen.has(p.id) ? false : (seen.add(p.id), true)));

  // Compare status IDs numerically (Twitter snowflake IDs increase over time)
  // instead of relying on DOM position, because a pinned post can sit first
  // in the DOM despite being older than the account's actual latest post.
  const lastSeenId = state[handle] ? BigInt(state[handle]) : null;
  const newPosts = uniquePosts
    .filter(p => lastSeenId === null || BigInt(p.id) > lastSeenId)
    .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? 1 : -1)); // oldest new post first

  for (const p of newPosts) {
    // Re-fetch from the status page so we get the full, untruncated text
    // instead of the "Show more"-clipped preview from the timeline. Fall
    // back to the timeline text if this fails for any reason.
    let full = { text: p.text, quoted: p.quoted };
    try {
      full = await fetchFullPostText(page, p.url);
    } catch (err) {
      console.error(`Failed to fetch full text for ${handle} ${p.id}, using timeline preview:`, err.message);
    }

    let original = full.text || '';
    if (full.quoted && full.quoted.text) {
      original += (original ? '\n\n' : '') + `[引用 @${full.quoted.author}]：${full.quoted.text}`;
    }

    let message;
    if (!original) {
      // Don't silently drop posts we couldn't extract text from (e.g. a
      // pure media quote-repost, or a DOM/selector mismatch) — always notify
      // with the link so nothing goes missing, and log it for debugging.
      message = `## ${handle} 新貼文\n(未擷取到文字內容，可能是純媒體貼文)\n連結：${p.url}`;
      console.log(`No text extracted for ${handle} ${p.id}, notifying with link only`);
    } else {
      const translated = await translateToZhTW(original);
      message = `## ${handle} 新貼文\n**原文：**\n${original}\n\n**翻譯：**\n${translated}\n\n連結：${p.url}`;
    }

    await sendDiscordLong(message);
    console.log(`Notified: ${handle} ${p.id}`);
  }

  // Seed with the existing stored value (if any) so the baseline can only move
  // forward. Without this, a run where the previous newest post briefly drops
  // out of the fetched timeline (ads/reordering/rendering variance) would push
  // the baseline backward and cause that post to be re-notified later.
  const seed = state[handle] || uniquePosts[0].id;
  state[handle] = uniquePosts.reduce((max, p) => (BigInt(p.id) > BigInt(max) ? p.id : max), seed);
}

async function checkYouTubeChannel(page, channelHandle, state) {
  const key = `yt:${channelHandle}`;
  await page.goto(`https://www.youtube.com/@${channelHandle}/posts`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // Community posts have no numeric/pinned ordering like X — the feed is
  // assumed newest-first in DOM order, so we stop at the last-seen post id.
  const posts = await page.$$eval('ytd-backstage-post-thread-renderer', threads =>
    threads.map(thread => {
      const idLink = thread.querySelector('a[href^="/post/"]');
      if (!idLink) return null;
      const href = idLink.getAttribute('href');
      const id = href.split('/post/')[1]?.split(/[/?]/)[0];
      if (!id) return null;
      const textEl = thread.querySelector('#content-text');
      return { id, url: `https://www.youtube.com${href}`, text: textEl ? textEl.innerText : '' };
    }).filter(Boolean)
  );

  if (posts.length === 0) {
    const title = await page.title();
    const bodySnippet = await page.evaluate(() => document.body.innerText.slice(0, 300));
    console.log(`${key}: no posts found. title="${title}" bodySnippet="${bodySnippet.replace(/\n/g, ' ')}"`);
    return;
  }

  const lastSeenId = state[key];
  const newPosts = [];
  for (const p of posts) {
    if (p.id === lastSeenId) break;
    newPosts.push(p);
  }
  newPosts.reverse(); // oldest new post first

  for (const p of newPosts) {
    let message;
    if (!p.text) {
      message = `## ${channelHandle} 新社群貼文\n(未擷取到文字內容)\n連結：${p.url}`;
      console.log(`No text extracted for ${key} ${p.id}, notifying with link only`);
    } else if (isMostlyChinese(p.text)) {
      // Already in Chinese — skip the translate call and the redundant line.
      message = `## ${channelHandle} 新社群貼文\n${p.text}\n\n連結：${p.url}`;
    } else {
      const translated = await translateToZhTW(p.text);
      message = `## ${channelHandle} 新社群貼文\n**原文：**\n${p.text}\n\n**翻譯：**\n${translated}\n\n連結：${p.url}`;
    }
    await sendDiscordLong(message, YT_DISCORD_WEBHOOK);
    console.log(`Notified: ${key} ${p.id}`);
  }

  state[key] = posts[0].id;
}

async function main() {
  if (!DISCORD_WEBHOOK || !AUTH_TOKEN || !CT0) {
    console.error('Missing required environment variables (DISCORD_WEBHOOK_URL / X_AUTH_TOKEN / X_CT0).');
    process.exit(1);
  }

  const state = loadState();
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies([
    { name: 'auth_token', value: AUTH_TOKEN, domain: '.x.com', path: '/' },
    { name: 'ct0', value: CT0, domain: '.x.com', path: '/' }
  ]);
  const page = await context.newPage();

  for (const handle of ACCOUNTS) {
    try {
      await checkAccount(page, handle, state);
    } catch (err) {
      console.error(`Error checking ${handle}:`, err.message);
    }
  }

  for (const channelHandle of YOUTUBE_CHANNELS) {
    try {
      await checkYouTubeChannel(page, channelHandle, state);
    } catch (err) {
      console.error(`Error checking yt:${channelHandle}:`, err.message);
    }
  }

  await browser.close();
  saveState(state);
}

main();
