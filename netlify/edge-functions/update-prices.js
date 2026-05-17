import { DOMParser } from "https://deno.land/x/deno_dom/deno-dom-wasm.ts";

export default async () => {
  try {
    const prices = {};

    // --- 1. GET DSE STOCKS (CRDB, NMB, SWIS, IEACLC) ---
    const stockRes = await fetch("https://itrust.co.tz/today-market");
    const stockHtml = await stockRes.text();
    const stockDoc = new DOMParser().parseFromString(stockHtml, "text/html");
    
    const stockRows = stockDoc.querySelectorAll("table tr");
    stockRows.forEach(row => {
      const cols = row.querySelectorAll("td");
      if (cols.length > 2) {
        const name = cols[0].textContent.trim().toUpperCase();
        const price = cols[2].textContent.trim().replace(/,/g, '');
        // Capture your specific stocks and the IEACLC ETF
        if (["CRDB", "NMB", "SWIS","NICO", "IEACLC-ETF"].includes(name)) {
          prices[name] = parseFloat(price);
        }
      }
    });

    // --- 2. GET IGROWTH NAV (from iTrust i-Invest page) ---
    const igrowthRes = await fetch("https://www.itrust.co.tz/services/i-invest");
    const igrowthHtml = await igrowthRes.text();
    const igrowthDoc = new DOMParser().parseFromString(igrowthHtml, "text/html");
    
    // We look for the text "iGrowth" and then find the number near it
    const igrowthText = igrowthDoc.body.textContent;
    const igrowthMatch = igrowthText.match(/iGrowth.*?(\d+\.\d+)/i);
    if (igrowthMatch) {
      prices["IGROWTH"] = parseFloat(igrowthMatch[1]);
    }

    // --- 3. GET UTT AMIS NAV (Liquid, Umoja) ---
    const uttRes = await fetch("https://uttamis.co.tz/fund-performance");
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

    // Return all gathered prices
    return new Response(JSON.stringify(prices), { 
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    // Return error if any site is down, prevents updating your Supabase with "0"
    return new Response(JSON.stringify({ error: "failed" }), { status: 500 });
  }
};

// Helper function to find numbers like 123.45 in a string of text
function extractNav(text) {
  const match = text.match(/\d+\.\d+/); 
  return match ? parseFloat(match[0]) : null;
}
