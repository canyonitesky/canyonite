// sync.js
// Attach GHL media to Shopify products by code (CS1, CS2…)
// - Accepts BOTH env name pairs:
//     SHOPIFY_STORE_DOMAIN  || SHOPIFY_SHOP_DOMAIN
//     SHOPIFY_ADMIN_TOKEN   || SHOPIFY_ADMIN_API_TOKEN
// - Respects PRODUCT_CODE_REGEX and PRODUCT_HANDLE_TEMPLATE
// - Uses DRY_RUN=true to simulate without writing

import 'dotenv/config';
import fetch from 'node-fetch';

/* ───────────────────────── Env & constants ───────────────────────── */
const SHOP =
  process.env.SHOPIFY_STORE_DOMAIN ||
  process.env.SHOPIFY_SHOP_DOMAIN ||
  '';

const TOKEN =
  process.env.SHOPIFY_ADMIN_TOKEN ||
  process.env.SHOPIFY_ADMIN_API_TOKEN ||
  '';

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-07';
const API = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

const GHL_FILES_ENDPOINT = process.env.GHL_FILES_ENDPOINT || '';
const GHL_API_KEY = process.env.GHL_API_KEY || '';

const DRY_RUN = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true';
const MEDIA_BATCH_SIZE = Number(process.env.MEDIA_BATCH_SIZE || 8);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);

// Compile regex safely; default to ^CS\d+
let PRODUCT_CODE_REGEX;
try {
  PRODUCT_CODE_REGEX = new RegExp(
    process.env.PRODUCT_CODE_REGEX || '^CS\\d+',
    'i'
  );
} catch {
  PRODUCT_CODE_REGEX = /^CS\d+/i;
}
const HANDLE_TEMPLATE = process.env.PRODUCT_HANDLE_TEMPLATE || '${codeLower}';

/* ───────────────────────── Guard rails ───────────────────────── */
function mask(s) {
  if (!s) return '(empty)';
  if (s.length <= 6) return '***';
  return s.slice(0, 3) + '***' + s.slice(-3);
}

console.log('────────────────────────────────────────────────────────');
console.log('Canyonite GHL → Shopify Sync');
console.log(`Store domain: ${SHOP || '(missing)'}`);
console.log(`API version : ${API_VERSION}`);
console.log(`Token seen  : ${mask(TOKEN)}`);
console.log(`GHL endpoint: ${GHL_FILES_ENDPOINT || '(missing)'}`);
console.log(`GHL key seen: ${mask(GHL_API_KEY)}`);
console.log(`DRY_RUN     : ${DRY_RUN}`);
console.log(`Code regex  : ${PRODUCT_CODE_REGEX}`);
console.log(`Handle tpl  : ${HANDLE_TEMPLATE}`);
console.log('────────────────────────────────────────────────────────');

if (!SHOP || !TOKEN) {
  console.error(
    '❌ Missing required Shopify env. Need either:\n' +
      '   SHOPIFY_STORE_DOMAIN or SHOPIFY_SHOP_DOMAIN\n' +
      '   and\n' +
      '   SHOPIFY_ADMIN_TOKEN or SHOPIFY_ADMIN_API_TOKEN'
  );
  process.exit(1);
}
if (!GHL_FILES_ENDPOINT) {
  console.error('❌ Missing GHL_FILES_ENDPOINT.');
  process.exit(1);
}

/* ───────────────────────── Small helpers ───────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function filenameFromUrl(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop());
  } catch {
    return (url || '').split('/').pop();
  }
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v']);
const extOf = (n) => (String(n).toLowerCase().match(/\.[a-z0-9]+$/)?.[0]) || '';

function guessMediaType(f) {
  const mime = (f.mime || '').toLowerCase();
  const name = f.name || filenameFromUrl(f.url);
  const ext = extOf(name);
  if (mime.startsWith('image/') || IMAGE_EXT.has(ext)) return 'IMAGE';
  if (mime.startsWith('video/') || VIDEO_EXT.has(ext)) return 'VIDEO';
  return 'EXTERNAL_VIDEO';
}

function extractCode(str) {
  const m = String(str || '').match(PRODUCT_CODE_REGEX);
  return m ? m[0].toUpperCase() : null; // CS1, CS2…
}

function deriveHandleFromCode(code) {
  const codeLower = code.toLowerCase();
  const codeUpper = code.toUpperCase();
  const codeNum = code.replace(/\D+/g, '');
  return HANDLE_TEMPLATE
    .replaceAll('${codeLower}', codeLower)
    .replaceAll('${codeUpper}', codeUpper)
    .replaceAll('${codeNum}', codeNum);
}

/* ───────────────────────── Shopify GraphQL ───────────────────────── */
async function gql(query, variables = {}, attempt = 1) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.text();
    const retryable = [429, 500, 502, 503, 504].includes(res.status);
    if (retryable && attempt < MAX_RETRIES) {
      const wait = 600 * 2 ** (attempt - 1);
      console.warn(
        `⚠️ GraphQL ${res.status}; retry ${attempt}/${MAX_RETRIES} in ${wait}ms`
      );
      await sleep(wait);
      return gql(query, variables, attempt + 1);
    }
    throw new Error(`GraphQL HTTP ${res.status}: ${body}`);
  }

  const json = await res.json();
  if (json.errors) {
    if (attempt < MAX_RETRIES) {
      const wait = 600 * 2 ** (attempt - 1);
      console.warn(
        `⚠️ GraphQL errors; retry ${attempt}/${MAX_RETRIES} in ${wait}ms`
      );
      await sleep(wait);
      return gql(query, variables, attempt + 1);
    }
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function findProductIdByHandleOrSku({ handle, code }) {
  // 1) handle
  if (handle) {
    const q = `query($handle:String!){ product(handle:$handle){ id } }`;
    const d = await gql(q, { handle });
    if (d.product?.id) return d.product.id;
  }
  // 2) sku
  if (code) {
    const q = `query($q:String!){ products(first:1, query:$q){ edges{ node{ id title } } } }`;
    const d = await gql(q, { q: `sku:${code}` });
    const node = d.products?.edges?.[0]?.node;
    if (node?.id) return node.id;
  }
  return null;
}

async function getExistingMediaAlts(productId) {
  const q = `
    query($id:ID!){
      product(id:$id){
        media(first:250){ edges{ node{ alt } } }
      }
    }
  `;
  const d = await gql(q, { id: productId });
  const edges = d.product?.media?.edges || [];
  return new Set(
    edges.map((e) => (e.node?.alt || '').trim()).filter((s) => s.length)
  );
}

async function attachMediaBatch(productId, medias) {
  if (!medias.length) return;
  const m = `
    mutation($productId:ID!, $media:[CreateMediaInput!]!){
      productCreateMedia(productId:$productId, media:$media){
        media { alt mediaContentType status }
        mediaUserErrors { code field message }
      }
    }
  `;
  const d = await gql(m, { productId, media: medias });
  const errs = d.productCreateMedia?.mediaUserErrors || [];
  if (errs.length) throw new Error(`mediaUserErrors: ${JSON.stringify(errs)}`);
}

/* ───────────────────────── GHL fetcher ───────────────────────── */
async function fetchGhlFiles() {
  const headers = {};
  if (GHL_API_KEY) headers.Authorization = `Bearer ${GHL_API_KEY}`;

  const res = await fetch(GHL_FILES_ENDPOINT, { headers });
  if (!res.ok) {
    throw new Error(`GHL fetch HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();

  // Accept either an array or {files:[...]} and tolerate different field names
  const list = Array.isArray(json) ? json : Array.isArray(json.files) ? json.files : null;
  if (!list) {
    throw new Error(
      'GHL endpoint must return an array (or {files:[]}) of { url|link|path, name?, mime|type? }'
    );
  }

  return list
    .filter((f) => f && (f.url || f.link || f.path))
    .map((f) => {
      const url = f.url || f.link || f.path;
      const name = f.name || filenameFromUrl(url);
      const mime = f.mime || f.type || '';
      return { url, name, mime };
    });
}

/* ───────────────────────── Main ───────────────────────── */
(async () => {
  const files = await fetchGhlFiles();
  if (!files.length) {
    console.log('ℹ️ No files returned from GHL.');
    return;
  }

  // Build index: CODE -> [mediaInputs]
  const mediaByCode = new Map();
  for (const f of files) {
    const code = extractCode(f.name || f.url);
    if (!code) continue;
    const alt = (f.name || filenameFromUrl(f.url)).trim();
    const mediaContentType = guessMediaType(f);
    const mediaInput = { alt, mediaContentType, originalSource: f.url };

    if (!mediaByCode.has(code)) mediaByCode.set(code, []);
    mediaByCode.get(code).push(mediaInput);
  }

  if (!mediaByCode.size) {
    console.log(
      `ℹ️ No filenames matched PRODUCT_CODE_REGEX (${PRODUCT_CODE_REGEX}).`
    );
    return;
  }

  let attachedTotal = 0;
  let skippedTotal = 0;

  for (const [code, allMedias] of mediaByCode.entries()) {
    const handle = deriveHandleFromCode(code);
    const productId = await findProductIdByHandleOrSku({ handle, code });

    if (!productId) {
      console.warn(
        `⚠️ No product found for code=${code} (tried handle="${handle}" and sku:${code})`
      );
      continue;
    }

    const existingAlts = await getExistingMediaAlts(productId);
    const toAttach = allMedias.filter(
      (m) => !existingAlts.has((m.alt || '').trim())
    );

    skippedTotal += allMedias.length - toAttach.length;

    if (!toAttach.length) {
      console.log(`✔︎ Nothing new for product(${handle || code}).`);
      continue;
    }

    if (DRY_RUN) {
      console.log(
        `[DRY_RUN] Would attach ${toAttach.length} media → product(${handle || code})`
      );
      continue;
    }

    for (let i = 0; i < toAttach.length; i += MEDIA_BATCH_SIZE) {
      const chunk = toAttach.slice(i, i + MEDIA_BATCH_SIZE);
      await attachMediaBatch(productId, chunk);
      attachedTotal += chunk.length;
      console.log(
        `✔︎ Attached ${chunk.length}/${toAttach.length} → product(${handle || code})`
      );
    }
  }

  console.log('────────────────────────────────────────────────────────');
  console.log(`Summary: attached=${attachedTotal}, skipped(existing)=${skippedTotal}`);
  console.log('✅ Done.');
})().catch((err) => {
  console.error('❌ Sync failed:', err?.message || err);
  process.exit(1);
});
