import 'dotenv/config';
import fetch from 'node-fetch';

const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN;
if (!SHOP || !TOKEN) {
  console.error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN in environment");
  process.exit(1);
}
const API = `https://${SHOP}/admin/api/2024-07/graphql.json`;

async function gql(query, variables = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

function filenameFromUrl(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop()); }
  catch { return url.split('/').pop(); }
}
const IMAGE_EXT = new Set(['.jpg','.jpeg','.png','.webp','.gif']);
const VIDEO_EXT = new Set(['.mp4','.mov','.webm','.m4v']);
const extOf = name => (name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0]) || '';
function guessMediaType(f) {
  const mime = (f.mime || '').toLowerCase();
  const name = f.name || filenameFromUrl(f.url);
  const ext = extOf(name);
  if (mime.startsWith('image/') || IMAGE_EXT.has(ext)) return 'IMAGE';
  if (mime.startsWith('video/') || VIDEO_EXT.has(ext)) return 'VIDEO';
  return 'EXTERNAL_VIDEO';
}

const CODE_RE = new RegExp(process.env.PRODUCT_CODE_REGEX || "^CS\d+", "i");
function extractCodeFromFilename(nameOrUrl) {
  const m = (nameOrUrl || '').match(CODE_RE);
  return m ? m[0].toUpperCase() : null;
}
function deriveHandleFromCode(code) {
  const tpl = process.env.PRODUCT_HANDLE_TEMPLATE || "${codeLower}";
  const codeLower = code.toLowerCase();
  const codeUpper = code.toUpperCase();
  const codeNum = code.replace(/\D+/g, "");
  return tpl.replaceAll("${codeLower}", codeLower)
            .replaceAll("${codeUpper}", codeUpper)
            .replaceAll("${codeNum}", codeNum);
}

async function findProductIdByHandleOrSku({ handle, code }) {
  if (handle) {
    const q1 = `query($handle:String!){ product(handle:$handle){ id } }`;
    const d1 = await gql(q1, { handle });
    if (d1.product?.id) return d1.product.id;
  }
  if (code) {
    const q2 = `query($q:String!){ products(first:1, query:$q){ edges{ node{ id title } } } }`;
    const d2 = await gql(q2, { q: `sku:${code}` });
    const node = d2.products?.edges?.[0]?.node;
    if (node?.id) return node.id;
  }
  return null;
}

async function attachMediaToProduct({ productId, medias }) {
  const m = `mutation($productId:ID!, $media:[CreateMediaInput!]!){
    productCreateMedia(productId:$productId, media:$media){
      media { alt mediaContentType status }
      mediaUserErrors { code field message }
    }
  }`;
  const data = await gql(m, { productId, media: medias });
  const errs = data.productCreateMedia?.mediaUserErrors;
  if (errs?.length) throw new Error(`mediaUserErrors: ${JSON.stringify(errs)}`);
  return data;
}

async function fetchGhlFiles() {
  const endpoint = process.env.GHL_FILES_ENDPOINT;
  if (!endpoint) throw new Error("Set GHL_FILES_ENDPOINT to a JSON array endpoint");
  const headers = {};
  if (process.env.GHL_API_KEY) headers.Authorization = `Bearer ${process.env.GHL_API_KEY}`;
  const res = await fetch(endpoint, { headers });
  if (!res.ok) throw new Error(`GHL fetch HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error("Endpoint must return an array of { url, name?, mime? }");
  return json.filter(f => f && f.url).map(f => ({
    url: f.url, name: f.name || filenameFromUrl(f.url), mime: f.mime || ""
  }));
}

(async () => {
  const files = await fetchGhlFiles();
  const byCode = new Map();
  for (const f of files) {
    const code = extractCodeFromFilename(f.name || filenameFromUrl(f.url));
    if (!code) continue;
    const mediaContentType = guessMediaType(f);
    const mediaInput = { alt: f.name, mediaContentType, originalSource: f.url };
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(mediaInput);
  }

  for (const [code, medias] of byCode.entries()) {
    const handle = deriveHandleFromCode(code);
    const productId = await findProductIdByHandleOrSku({ handle, code });
    if (!productId) { console.warn(`No product for code=${code} (handle="${handle}" or sku:${code})`); continue; }

    if (process.env.DRY_RUN === 'true') {
      console.log(`[DRY_RUN] Would attach ${medias.length} media → product(${handle || code})`);
      continue;
    }

    await attachMediaToProduct({ productId, medias });
    console.log(`Attached ${medias.length} media → product(${handle || code})`);
  }
  console.log("Done.");
})().catch(e => { console.error(e); process.exit(1); });
