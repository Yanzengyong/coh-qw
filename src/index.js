const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

loadEnvFile(path.resolve(process.cwd(), '.env'));

const config = {
  targetUrl: env('TARGET_URL', 'https://cohcigars.com/cigars-bundle-clearance'),
  country: env('COH_COUNTRY', 'China'),
  intervalSeconds: numberEnv('CHECK_INTERVAL_SECONDS', 60),
  requestTimeoutMs: numberEnv('REQUEST_TIMEOUT_MS', 60000),
  stateFile: path.resolve(process.cwd(), env('STATE_FILE', 'data/coh-clearance-state.json')),
  firstRunNotify: boolEnv('FIRST_RUN_NOTIFY', false),
  includePriceChanges: boolEnv('INCLUDE_PRICE_CHANGES', true),
  pushProvider: env('PUSH_PROVIDER', ''),
  pushplusToken: env('PUSHPLUS_TOKEN', ''),
  pushplusTopic: env('PUSHPLUS_TOPIC', ''),
  serverchanSendkey: env('SERVERCHAN_SENDKEY', ''),
  wecomBotWebhook: env('WECOM_BOT_WEBHOOK', ''),
  webhookUrl: env('WEBHOOK_URL', ''),
};

const userAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const landedPriceMultiplier = 1.5 * 6.9;
const wecomMarkdownMaxBytes = 3500;

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  absorb(headers) {
    const setCookies = getSetCookieHeaders(headers);
    for (const item of setCookies) {
      const pair = item.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  header() {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));

  if (args.has('--test-notify')) {
    await sendNotification('COH 监听器测试', `测试时间：${new Date().toLocaleString()}`);
    console.log('Test notification sent.');
    return;
  }

  if (args.has('--once')) {
    await runOnce();
    return;
  }

  console.log(`Monitoring ${config.targetUrl}`);
  console.log(`Country: ${config.country}; interval: ${config.intervalSeconds}s; push: ${config.pushProvider}`);
  await runOnce().catch((error) => console.error(`[${now()}] Check failed:`, error.message));
  setInterval(() => {
    runOnce().catch((error) => console.error(`[${now()}] Check failed:`, error.message));
  }, config.intervalSeconds * 1000);
}

async function runOnce() {
  const current = await fetchCurrentProducts();
  const previous = readState(config.stateFile);
  const history = previous.history || previous.products || [];
  const diff = compareProducts(previous.products || [], current.products, history);

  const nextState = buildState(current.products, previous);

  if (!previous.products) {
    if (config.firstRunNotify) {
      await sendNotification(
        'COH Bundled Clearance 初始快照',
        formatInitialSnapshot(current.products)
      );
    }
    writeState(config.stateFile, nextState);
    console.log(`[${now()}] Initial snapshot saved: ${current.products.length} products.`);
    return;
  }

  const hasChanges =
    diff.added.length > 0 ||
    diff.removed.length > 0 ||
    diff.lowStock.length > 0 ||
    (config.includePriceChanges && diff.priceChanged.length > 0);

  if (!hasChanges) {
    writeState(config.stateFile, nextState);
    console.log(`[${now()}] No changes. Products: ${current.products.length}`);
    return;
  }

  await sendDiffNotifications(diff);
  writeState(config.stateFile, nextState);
  console.log(`[${now()}] Change notification sent.`);
}

function buildState(products, previous = {}) {
  return {
    checkedAt: new Date().toISOString(),
    url: config.targetUrl,
    country: config.country,
    count: products.length,
    products,
    history: mergeProductHistory(previous.history || previous.products || [], products),
  };
}

async function fetchCurrentProducts() {
  const jar = new CookieJar();
  await request('https://cohcigars.com/', { jar });
  let response = await request(config.targetUrl, { jar });
  let html = await response.text();

  if (needsCountrySelection(html)) {
    await selectCountry(html, jar);
    response = await request(config.targetUrl, { jar, referer: config.targetUrl });
    html = await response.text();
  }

  if (needsCountrySelection(html)) {
    throw new Error(`Country selection did not complete. Check COH_COUNTRY=${config.country}.`);
  }

  const products = parseProducts(html, config.targetUrl);
  if (products.length === 0) {
    fs.writeFileSync(path.resolve(process.cwd(), 'data/last-empty-page.html'), html);
    throw new Error('No products parsed. Saved data/last-empty-page.html for inspection.');
  }

  return { html, products };
}

async function selectCountry(html, jar) {
  const $ = cheerio.load(html);
  const form = $('form#frmselcountry').first();
  if (!form.length) throw new Error('Country form not found.');

  const action = absolutizeUrl(form.attr('action') || config.targetUrl, config.targetUrl);
  const data = new URLSearchParams();

  form.find('input').each((_, el) => {
    const input = $(el);
    const name = input.attr('name');
    const type = (input.attr('type') || '').toLowerCase();
    if (!name || ['button', 'submit', 'image'].includes(type)) return;
    data.set(name, input.attr('value') || '');
  });

  data.set('__EVENTTARGET', 'btnSubmit');
  data.set('__EVENTARGUMENT', '');
  data.set('cmbENCountry', config.country);

  const response = await request(action, {
    jar,
    method: 'POST',
    referer: config.targetUrl,
    body: data.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  await response.text();
}

function parseProducts(html, pageUrl) {
  const $ = cheerio.load(html);
  const bundleProducts = parseBundleProducts($, pageUrl);
  if (bundleProducts.length > 0) return bundleProducts;

  const candidates = [];

  $('a[href*="details"], a[href*="product"], a[href*="cigar"]').each((_, el) => {
    const link = $(el);
    const name = cleanText(link.text());
    const href = link.attr('href');
    if (!name || !href) return;
    if (name.length < 4 || isNavigationText(name)) return;

    const area = nearestProductArea($, link);
    const text = cleanText(area.text());
    const price = extractPrice(text);
    if (!price && !looksLikeProductText(text)) return;

    candidates.push(enrichProductPricing({
      id: stableId(absolutizeUrl(href, pageUrl), name),
      name,
      price: price || '',
      url: absolutizeUrl(href, pageUrl),
      status: extractStatus(text),
      raw: text.slice(0, 500),
    }));
  });

  return dedupeProducts(candidates).sort((a, b) => a.name.localeCompare(b.name));
}

function parseBundleProducts($, pageUrl) {
  const products = [];

  $('span.product_header').each((_, el) => {
    const header = $(el);
    const title = cleanText(header.text());
    if (!/^Bundle Clearance\s+-\s+/i.test(title)) return;

    const area = header.closest('table');
    const text = cleanText(area.text());
    const onclick = area.find('input[value="Add to Cart"]').first().attr('onclick') || '';
    const cartUrl = extractCartUrl(onclick, pageUrl);
    const cartParams = cartUrl ? new URL(cartUrl).searchParams : new URLSearchParams();
    const price = cleanText(area.find('.pricetxt').first().text()).replace(/\$\s+/, '$ ');
    const box = cleanText(area.find('strong').first().text());
    const stock = cartParams.get('pstk') || '';
    const productId = cartParams.get('prid') || '';
    const boxId = cartParams.get('bxid') || '';
    const name = title.replace(/^Bundle Clearance\s+-\s+/i, '').trim();

    products.push(enrichProductPricing({
      id: productId && boxId ? `${productId}-${boxId}` : stableId(cartUrl || pageUrl, name),
      name,
      price: price || extractPrice(text),
      url: cartUrl || pageUrl,
      stock: stock ? Number(stock) : undefined,
      status: stock ? `可购买，库存 ${stock}` : extractStatus(text) || '可购买',
      box,
      raw: text.slice(0, 500),
    }));
  });

  return dedupeProducts(products).sort((a, b) => a.name.localeCompare(b.name));
}

function extractCartUrl(onclick, pageUrl) {
  const decoded = onclick.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const match = decoded.match(/AddToCart\.aspx\?[^"]+/i);
  return match ? absolutizeUrl(match[0], pageUrl) : '';
}

function nearestProductArea($, link) {
  let node = link;
  for (const selector of ['td', 'tr', 'table', 'div']) {
    const parent = node.closest(selector);
    if (parent.length && cleanText(parent.text()).length > cleanText(link.text()).length + 10) {
      return parent;
    }
  }
  return link.parent();
}

function compareProducts(previous, current, history = []) {
  const oldMap = new Map(previous.map((item) => [item.id, item]));
  const newMap = new Map(current.map((item) => [item.id, item]));

  const added = current
    .filter((item) => !oldMap.has(item.id))
    .map((item) => addHistoricalPriceComparison(item, history));
  const removed = previous.filter((item) => !newMap.has(item.id));
  const lowStock = current.filter((item) => isNewLowStock(item, oldMap.get(item.id)));
  const priceChanged = current
    .filter((item) => oldMap.has(item.id) && normalizePrice(oldMap.get(item.id).price) !== normalizePrice(item.price))
    .map((item) => ({ before: oldMap.get(item.id), after: item }));

  return { added, removed, lowStock, priceChanged };
}

function isNewLowStock(current, previous) {
  const currentStock = getProductStock(current);
  if (![1, 2].includes(currentStock)) return false;

  const previousStock = previous ? getProductStock(previous) : undefined;
  return previousStock !== currentStock;
}

function getProductStock(product) {
  if (!product) return undefined;
  if (Number.isFinite(product.stock)) return product.stock;

  const match = (product.status || '').match(/库存\s*(\d+)/);
  return match ? Number(match[1]) : undefined;
}

function addHistoricalPriceComparison(product, history) {
  const currentPrice = parseUsdAmount(product.price);
  if (!currentPrice) return product;

  const productKey = productComparisonKey(product);
  const match = history
    .filter((item) => productComparisonKey(item) === productKey)
    .filter((item) => normalizePrice(item.price) !== normalizePrice(product.price))
    .sort((a, b) => new Date(b.lastSeenAt || b.firstSeenAt || 0) - new Date(a.lastSeenAt || a.firstSeenAt || 0))[0];

  if (!match) return product;

  const previousPrice = parseUsdAmount(match.price);
  if (!previousPrice) return product;

  return {
    ...product,
    priceComparison: formatHistoricalPriceComparison(match, product, previousPrice, currentPrice),
  };
}

function formatHistoricalPriceComparison(previous, current, previousPrice, currentPrice) {
  const totalDiffUsd = currentPrice - previousPrice;
  const totalDiffCny = totalDiffUsd * landedPriceMultiplier;
  const quantity = current.quantity || previous.quantity || extractProductQuantity(current.name, current.box);
  const direction = totalDiffUsd > 0 ? '贵了' : '便宜了';
  const totalDiffText = `${formatUsd(Math.abs(totalDiffUsd))} / ${formatCny(Math.abs(totalDiffCny))}`;
  const unitDiffText = quantity ? `，单支${direction}${formatCny(Math.abs(totalDiffCny) / quantity)}` : '';

  return `历史价 ${previous.price || '未知价格'} -> 本次 ${current.price || '未知价格'}，${direction}${totalDiffText}${unitDiffText}`;
}

function mergeProductHistory(history, products) {
  const nowIso = new Date().toISOString();
  const map = new Map();

  for (const item of history) {
    const key = productHistoryKey(item);
    map.set(key, {
      ...item,
      firstSeenAt: item.firstSeenAt || item.checkedAt || nowIso,
      lastSeenAt: item.lastSeenAt || item.checkedAt || nowIso,
    });
  }

  for (const product of products) {
    const key = productHistoryKey(product);
    const existing = map.get(key);
    map.set(key, {
      ...existing,
      ...product,
      firstSeenAt: existing?.firstSeenAt || nowIso,
      lastSeenAt: nowIso,
    });
  }

  return Array.from(map.values()).sort((a, b) => productComparisonKey(a).localeCompare(productComparisonKey(b)));
}

function enrichProductPricing(product) {
  const totalPriceUsd = parseUsdAmount(product.price);
  const quantity = extractProductQuantity(product.name, product.box);

  if (!totalPriceUsd) return product;

  const landedTotalCny = totalPriceUsd * landedPriceMultiplier;
  const enriched = {
    ...product,
    landedPrice: formatCny(landedTotalCny),
  };

  if (quantity) {
    const unitPriceUsd = totalPriceUsd / quantity;
    const unitLandedCny = landedTotalCny / quantity;
    enriched.quantity = quantity;
    enriched.unitPrice = `${formatUsd(unitPriceUsd)}【单支大约到手 ${formatCny(unitLandedCny)}】`;
  }

  return enriched;
}

function parseUsdAmount(price) {
  const match = (price || '').match(/\$ ?([0-9][0-9,]*(?:\.[0-9]{1,2})?)/);
  return match ? Number(match[1].replace(/,/g, '')) : 0;
}

function extractProductQuantity(name, box) {
  const packMatches = Array.from((name || '').matchAll(/(\d+)\s*(?:pk|pack|packs)\b/gi));
  if (packMatches.length > 0) {
    return packMatches.reduce((sum, match) => sum + Number(match[1]), 0);
  }

  const boxMatch = (box || '').match(/(\d+)\s*Box/i);
  return boxMatch ? Number(boxMatch[1]) : 0;
}

function formatUsd(amount) {
  return `$ ${amount.toFixed(2)}`;
}

function formatCny(amount) {
  return `¥${amount.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDiff(diff) {
  const lines = [];
  appendSection(lines, '上架', diff.added.map(formatProduct));
  appendSection(lines, '下架', diff.removed.map(formatProduct));
  if (config.includePriceChanges) {
    appendSection(lines, '价格变化', diff.priceChanged.map(({ before, after }) => {
      return `${after.name}\n${before.price || '未知价格'} -> ${after.price || '未知价格'}\n${after.url}`;
    }));
  }
  lines.push(`\n检查时间：${new Date().toLocaleString()}`);
  return lines.join('\n');
}

async function sendDiffNotifications(diff) {
  const checkedAt = `检查时间：${new Date().toLocaleString()}`;
  const sections = [
    ['上架', diff.added, {}],
    ['库存告紧，即将下架', diff.lowStock, {}],
    ['下架', diff.removed, { includeStatus: false }],
  ];

  if (config.includePriceChanges) {
    sections.push(['价格变化', diff.priceChanged, {}]);
  }

  for (const [sectionTitle, items, options] of sections) {
    if (!items.length) continue;
    const title = `COH Bundled Clearance ${sectionTitle} ${items.length} 个`;
    const formattedItems = sectionTitle === '价格变化'
      ? items.map(({ before, after }) => {
          return `${after.name}\n${before.price || '未知价格'} -> ${after.price || '未知价格'}\n${after.url}`;
        })
      : items.map((item) => formatProduct(item, options));
    await sendNotification(title, [`【${sectionTitle}】`, ...formatItemBlocks(formattedItems), checkedAt].join('\n'));
  }
}

function formatItemBlocks(items) {
  return items.flatMap((item, index) => ['', '------------------------------', `${index + 1}. ${item}`]);
}

function formatInitialSnapshot(products) {
  const lines = [`当前共 ${products.length} 个商品。`, ''];
  for (const product of products) lines.push(formatProduct(product), '');
  return lines.join('\n').trim();
}

function appendSection(lines, title, items) {
  if (!items.length) return;
  lines.push(`【${title}】`);
  for (const item of items) lines.push(item, '');
}

function formatProduct(product, options = {}) {
  const includeStatus = options.includeStatus !== false;
  const parts = [product.name];
  if (product.price) {
    const landedPrice = product.landedPrice ? `【大约到手 ${product.landedPrice}】` : '';
    parts.push(`价格：${product.price}${landedPrice}`);
  }
  if (product.unitPrice) parts.push(`单只价格：${product.unitPrice}`);
  if (product.quantity) parts.push(`商品数量：${product.quantity} 支`);
  if (product.priceComparison) parts.push(`比价结果：${product.priceComparison}`);
  if (includeStatus && product.status) parts.push(`状态：${product.status}`);
  parts.push(`链接：${shortProductUrl(product)}`);
  return parts.join('\n');
}

function shortProductUrl(product) {
  if (!product.url) return config.targetUrl;
  try {
    const url = new URL(product.url);
    const productId = url.searchParams.get('prid');
    const boxId = url.searchParams.get('bxid');
    if (productId && boxId) return `${config.targetUrl}?prid=${productId}&bxid=${boxId}`;
  } catch (error) {
    return config.targetUrl;
  }
  return config.targetUrl;
}

async function sendNotification(title, content) {
  if (config.pushProvider === 'pushplus') return sendPushPlus(title, content);
  if (config.pushProvider === 'serverchan') return sendServerChan(title, content);
  if (config.pushProvider === 'wecom') return sendWecom(title, content);
  if (config.pushProvider === 'webhook') return sendWebhook(title, content);
  console.log(`\n${title}\n${content}\n`);
}

async function sendPushPlus(title, content) {
  if (!config.pushplusToken) throw new Error('PUSHPLUS_TOKEN is required.');
  const payload = {
    token: config.pushplusToken,
    title,
    content: content.replace(/\n/g, '<br>'),
    template: 'html',
  };
  if (config.pushplusTopic) payload.topic = config.pushplusTopic;
  await postJson('https://www.pushplus.plus/send', payload);
}

async function sendServerChan(title, content) {
  if (!config.serverchanSendkey) throw new Error('SERVERCHAN_SENDKEY is required.');
  await postForm(`https://sctapi.ftqq.com/${config.serverchanSendkey}.send`, {
    title,
    desp: content,
  });
}

async function sendWecom(title, content) {
  if (!config.wecomBotWebhook) throw new Error('WECOM_BOT_WEBHOOK is required.');
  const chunks = splitWecomMarkdown(title, content);
  for (const [index, chunk] of chunks.entries()) {
    const chunkTitle = chunks.length > 1 ? `${title} (${index + 1}/${chunks.length})` : title;
    await postJson(config.wecomBotWebhook, {
      msgtype: 'markdown',
      markdown: { content: `**${chunkTitle}**\n\n${chunk}` },
    });
  }
}

async function sendWebhook(title, content) {
  if (!config.webhookUrl) throw new Error('WEBHOOK_URL is required.');
  await postJson(config.webhookUrl, { title, content });
}

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const headers = {
    'user-agent': userAgent,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    ...options.headers,
  };
  if (options.referer) headers.referer = options.referer;
  if (options.jar && options.jar.header()) headers.cookie = options.jar.header();

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (options.jar) options.jar.absorb(response.headers);

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) return response;
      return request(absolutizeUrl(location, url), {
        jar: options.jar,
        method: response.status === 303 ? 'GET' : options.method,
        referer: url,
        body: response.status === 303 ? undefined : options.body,
        headers: options.headers,
      });
    }

    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': userAgent },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Push failed: HTTP ${response.status}`);
  const text = await response.text();
  const result = parseJsonResponse(text);
  if (result) {
    if (result.errcode !== undefined && result.errcode !== 0) {
      throw new Error(`Push failed: errcode=${result.errcode}, errmsg=${result.errmsg || ''}`);
    }
    if (result.errno !== undefined && result.errno !== 0) {
      throw new Error(`Push failed: errno=${result.errno}, errmsg=${result.errmsg || result.message || ''}`);
    }
    if (result.code !== undefined && ![0, 200].includes(result.code)) {
      throw new Error(`Push failed: code=${result.code}, message=${result.msg || result.message || ''}`);
    }
  } else if (/\"code\"\s*:\s*(?!200\b|0\b)\d+/.test(text) || /\"errno\"\s*:\s*(?!0\b)\d+/.test(text)) {
    throw new Error(`Push provider returned an error: ${text.slice(0, 500)}`);
  }
}

function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function splitWecomMarkdown(title, content) {
  const titleBytes = byteLength(`**${title} (999/999)**\n\n`);
  const maxContentBytes = Math.max(500, wecomMarkdownMaxBytes - titleBytes);
  const chunks = [];
  let current = '';

  for (const block of content.split(/\n\n+/)) {
    const next = current ? `${current}\n\n${block}` : block;
    if (byteLength(next) <= maxContentBytes) {
      current = next;
      continue;
    }

    if (current) chunks.push(current);
    if (byteLength(block) <= maxContentBytes) {
      current = block;
      continue;
    }

    const splitBlock = splitLongTextByBytes(block, maxContentBytes);
    chunks.push(...splitBlock.slice(0, -1));
    current = splitBlock[splitBlock.length - 1] || '';
  }

  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [''];
}

function splitLongTextByBytes(text, maxBytes) {
  const chunks = [];
  let current = '';

  for (const line of text.split('\n')) {
    const next = current ? `${current}\n${line}` : line;
    if (byteLength(next) <= maxBytes) {
      current = next;
      continue;
    }

    if (current) chunks.push(current);
    if (byteLength(line) <= maxBytes) {
      current = line;
      continue;
    }

    let piece = '';
    for (const char of line) {
      const nextPiece = piece + char;
      if (byteLength(nextPiece) > maxBytes) {
        chunks.push(piece);
        piece = char;
      } else {
        piece = nextPiece;
      }
    }
    current = piece;
  }

  if (current) chunks.push(current);
  return chunks;
}

function byteLength(text) {
  return Buffer.byteLength(text || '', 'utf8');
}

async function postForm(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': userAgent },
    body: new URLSearchParams(payload).toString(),
  });
  if (!response.ok) throw new Error(`Push failed: HTTP ${response.status}`);
}

function needsCountrySelection(html) {
  return /Select Country/i.test(html) && /cmbENCountry/i.test(html);
}

function extractPrice(text) {
  const match = text.match(/(?:US\$|USD|\$|€|£)\s?[0-9][0-9,]*(?:\.[0-9]{1,2})?/i);
  return match ? match[0].replace(/\s+/g, ' ') : '';
}

function extractStatus(text) {
  if (/out\s*of\s*stock|sold\s*out|unavailable/i.test(text)) return '缺货/不可用';
  if (/in\s*stock|add\s*to\s*cart|buy\s*now/i.test(text)) return '可购买';
  return '';
}

function looksLikeProductText(text) {
  return /(?:US\$|USD|\$|add\s*to\s*cart|out\s*of\s*stock|box|bundle|cigar)/i.test(text);
}

function isNavigationText(text) {
  return /^(home|my account|cart|checkout|login|specials|limited edition|regional release|singles|custom rolled|cuban cigars|non-cuban cigars)$/i.test(text);
}

function dedupeProducts(products) {
  const map = new Map();
  for (const product of products) {
    const key = product.id;
    const existing = map.get(key);
    if (!existing || product.raw.length > existing.raw.length) map.set(key, product);
  }
  return Array.from(map.values());
}

function stableId(url, name) {
  const normalizedUrl = url.split('#')[0].replace(/[?&](?:sid|session|utm_[^=]+)=[^&]+/gi, '');
  return normalizedUrl || name.toLowerCase().replace(/\s+/g, '-');
}

function normalizePrice(price) {
  return (price || '').replace(/\s+/g, '').toUpperCase();
}

function productHistoryKey(product) {
  return `${productComparisonKey(product)}|${normalizePrice(product.price)}`;
}

function productComparisonKey(product) {
  const name = normalizeProductName(product.name);
  const quantity = product.quantity || extractProductQuantity(product.name, product.box);
  return `${name}|${quantity || ''}`;
}

function normalizeProductName(name) {
  return (name || '')
    .replace(/^Bundle Clearance\s+-\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function absolutizeUrl(value, base) {
  return new URL(value, base).toString();
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return {};
  }
}

function writeState(file, state) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function env(name, fallback) {
  return process.env[name] === undefined || process.env[name] === '' ? fallback : process.env[name];
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.toLowerCase());
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const value = headers.get('set-cookie');
  return value ? value.split(/,(?=\s*[^;=]+=[^;]+)/) : [];
}

function now() {
  return new Date().toLocaleString();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
