const { chromium } = require('playwright');
const fs = require('fs');

const ACCOUNTS = ['realDonaldTrump', 'i1ota', 'elonmusk', 'TruthTrumpPost', 'JeffDean', 'DeItaone', 'unusual_whales'];
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

async function translateToZhTW(text) {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-TW&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    const data = await res.json();
    return data[0].map(seg => seg[0]).join('');
  } catch (err) {
    console.error('Translation failed:', err.message);
    return '（翻譯失敗）';
  }
}

async function sendDiscord(content, webhook = DISCORD_WEBHOOK) {
  await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
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
    let original = p.text || '';
    if (p.quoted && p.quoted.text) {
      original += (original ? '\n\n' : '') + `[引用 @${p.quoted.author}]：${p.quoted.text}`;
    }

    let message;
    if (!original) {
      // Don't silently drop posts we couldn't extract text from (e.g. a
      // pure media quote-repost, or a DOM/selector mismatch) — always notify
      // with the link so nothing goes missing, and log it for debugging.
      message = `【${handle} 新貼文】\n(未擷取到文字內容，可能是純媒體貼文)\n連結：${p.url}`;
      console.log(`No text extracted for ${handle} ${p.id}, notifying with link only`);
    } else {
      const translated = await translateToZhTW(original);
      message = `【${handle} 新貼文】\n原文：${original}\n翻譯：${translated}\n連結：${p.url}`;
    }

    await sendDiscord(message);
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
      message = `【${channelHandle} 新社群貼文】\n(未擷取到文字內容)\n連結：${p.url}`;
      console.log(`No text extracted for ${key} ${p.id}, notifying with link only`);
    } else if (isMostlyChinese(p.text)) {
      // Already in Chinese — skip the translate call and the redundant line.
      message = `【${channelHandle} 新社群貼文】\n${p.text}\n連結：${p.url}`;
    } else {
      const translated = await translateToZhTW(p.text);
      message = `【${channelHandle} 新社群貼文】\n原文：${p.text}\n翻譯：${translated}\n連結：${p.url}`;
    }
    await sendDiscord(message, YT_DISCORD_WEBHOOK);
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
