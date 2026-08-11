const { chromium } = require('playwright');
const fs = require('fs');

const ACCOUNTS = ['realDonaldTrump', 'i1ota'];
const STATE_FILE = 'state.json';

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
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

async function sendDiscord(content) {
  await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
}

async function checkAccount(page, handle, state) {
  await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const posts = await page.$$eval('article', articles =>
    articles.map(a => {
      const link = a.querySelector('a[href*="/status/"]');
      const textEl = a.querySelector('[data-testid="tweetText"]');
      if (!link) return null;
      const id = link.href.split('/status/')[1]?.split(/[/?]/)[0];
      if (!id) return null;
      return {
        id,
        url: `https://x.com/${link.href.split('/status/')[0].split('/').pop()}/status/${id}`,
        text: textEl ? textEl.innerText : ''
      };
    }).filter(Boolean)
  );

  if (posts.length === 0) {
    console.log(`${handle}: no posts found (page may be empty or blocked)`);
    return;
  }

  const lastSeenId = state[handle];
  const newPosts = [];
  for (const p of posts) {
    if (p.id === lastSeenId) break;
    newPosts.push(p);
  }
  newPosts.reverse(); // oldest new post first

  for (const p of newPosts) {
    if (!p.text) continue;
    const translated = await translateToZhTW(p.text);
    const message = `【${handle} 新貼文】\n原文：${p.text}\n翻譯：${translated}\n連結：${p.url}`;
    await sendDiscord(message);
    console.log(`Notified: ${handle} ${p.id}`);
  }

  state[handle] = posts[0].id;
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

  await browser.close();
  saveState(state);
}

main();
