import { DOMParser } from "https://deno.land/x/deno_dom/deno-dom-wasm.ts";

// Fetch with timeout — aborts if site doesn't respond within ms
async function fetchWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export default async () => {
  try {
    const prices = {};

    // --- 1. GET DSE STOCKS (CRDB, NMB, SWIS, IEACLC) ---
    try {
      const stockRes = await fetchWithTimeout("https://itrust.co.tz/today-market");
      const stockHtml = await stockRes.text();
      const stockDoc = new DOMParser().parseFromString(stockHtml, "text/html");

      const stockRows = stockDoc.querySelectorAll("table tr");
      stockRows.forEach(row => {
        const cols = row.querySelectorAll("td");
        if (cols.length > 2) {
          const name = cols[0].textContent.trim().toUpperCase();
          const price = cols[2].textContent.trim().replace(/,/g, '');
          if (["CRDB", "NMB", "SWIS", "NICO", "IEACLC-ETF"].includes(name)) {
            prices[name] = parseFloat(price);
          }
        }
      });
    } catch (_) { /* site timeout or down — skip */ }

    // --- 2. GET IGROWTH NAV (from iTrust i-Invest page) ---
    try {
      const igrowthRes = await fetchWithTimeout("https://www.itrust.co.tz/services/i-invest");
      const igrowthHtml = await igrowthRes.text();
      const igrowthDoc = new DOMParser().parseFromString(igrowthHtml, "text/html");
      const igrowthText = igrowthDoc.body.textContent;
      const igrowthMatch = igrowthText.match(/iGrowth.*?(\d+\.\d+)/i);
      if (igrowthMatch) {
        prices["IGROWTH"] = parseFloat(igrowthMatch[1]);
      }
    } catch (_) { /* site timeout or down — skip */ }

    // --- 3. GET UTT AMIS NAV (Liquid, Umoja) ---
    try {
      const uttRes = await fetchWithTimeout("https://uttamis.co.tz/fund-performance");
      const uttHtml = await uttRes.text();
      const uttDoc = new DOMParser().parseFromString(uttHtml, "text/html");
      const uttRows = uttDoc.querySelectorAll("table tr");
      uttRows.forEach(row => {
        const text = row.textContent.toUpperCase();
        if (text.includes("LIQUID")) {
          prices["LIQUID"] = extractNav(row.textContent);
        } else if (text.includes("UMOJA")) {
          prices["UMOJA"] = extractNav(row.textContent);
        }
      });
    } catch (_) { /* site timeout or down — skip */ }

    return new Response(JSON.stringify(prices), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: "failed" }), { status: 500 });
  }
};

function extractNav(text) {
  const match = text.match(/\d+\.\d+/);
  return match ? parseFloat(match[0]) : null;
}
