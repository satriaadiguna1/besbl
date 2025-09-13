// utils/cf.js
const CF_ZONE_ID    = process.env.CF_ZONE_ID;
const CF_API_TOKEN  = process.env.CF_API_TOKEN;
const ROOT_DOMAIN   = process.env.ROOT_DOMAIN;
const HEROKU_TARGET = (process.env.HEROKU_TARGET || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");

async function cfFetch(path, opts = {}) {
  const url = `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(opts.headers || {})
    }
  });
  const data = await res.json().catch(()=> ({}));
  if (!data || data.success !== true) {
    const detail = data?.errors?.length ? JSON.stringify(data.errors) : JSON.stringify(data);
    throw new Error(`Cloudflare API error: ${detail}`);
  }
  return data.result;
}

export function getRootDomain(){ return ROOT_DOMAIN; }

export async function createCNAME({ name, proxied = true }) {
  return cfFetch(`/dns_records`, {
    method: "POST",
    body: JSON.stringify({
      type: "CNAME",
      // jika kamu ingin record per-label, gunakan name: `<label>`
      // atau langsung FQDN: `${name}.${ROOT_DOMAIN}`
      name: `${name}.${ROOT_DOMAIN}`,
      content: HEROKU_TARGET,   // ← target hostname Heroku / frontend host
      ttl: 3600,
      proxied                   // true → pakai proxy Cloudflare (orange cloud)
    })
  });
}

export async function deleteDNSRecord(recordId) {
  return cfFetch(`/dns_records/${recordId}`, { method: "DELETE" });
}

export async function createEmailRoute({ to, destination, ruleName }) {
  return cfFetch(`/email/routing/rules`, {
    method: "POST",
    body: JSON.stringify({
      enabled: true,
      name: ruleName,
      matchers: [{ type: "literal", field: "to", value: to }],
      actions: [{ type: "forward", value: [destination] }]  // penting: array
    })
  });
}

export async function deleteEmailRoute(ruleId) {
  return cfFetch(`/email/routing/rules/${ruleId}`, { method: "DELETE" });
}
