import * as cheerio from "cheerio";

export interface SearchResult {
  title: string;
  link: string;
  snippet: string;
}

export interface ImageSearchResult {
  title: string;
  imageUrl: string;
  sourceUrl: string;
}

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9"
};

export async function runAstroWebSearch(query: string): Promise<SearchResult[]> {
  const cleanQuery = query.replace(/^(search for|find|look up|ابحث عن)\s+/i, "").trim();
  const targetUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`;

  const response = await fetch(targetUrl, { headers: HEADERS });
  const html = await response.text();
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];

  $(".result").each((_, element) => {
    if (results.length >= 5) return false;

    const titleElement = $(element).find(".result__title a");
    const title = titleElement.text().trim();
    let rawLink = titleElement.attr("href") || "";
    const snippet = $(element).find(".result__snippet").text().trim();

    // Decode DuckDuckGo redirect link to extract real destination
    let link = rawLink;
    if (rawLink.includes("uddg=")) {
      const match = rawLink.match(/uddg=([^&]+)/);
      if (match) link = decodeURIComponent(match[1]);
    }

    if (title && link && snippet) {
      results.push({ title, link, snippet });
    }
  });

  return results;
}

export async function runAstroImageSearch(query: string): Promise<ImageSearchResult[]> {
  const cleanQuery = query.replace(/^(search for|pictures of|images of|find pictures|ابحث عن صور|صور لـ)\s+/i, "").trim();
  const targetUrl = `https://www.bing.com/images/async?q=${encodeURIComponent(cleanQuery)}&first=1&count=8&mmasync=1`;

  const response = await fetch(targetUrl, { headers: HEADERS });
  const html = await response.text();
  const $ = cheerio.load(html);
  const images: ImageSearchResult[] = [];

  $("a.iusc").each((_, element) => {
    if (images.length >= 6) return false;

    const metadataAttr = $(element).attr("m");
    if (metadataAttr) {
      try {
        const parsed = JSON.parse(metadataAttr);
        if (parsed.murl) {
          images.push({
            title: parsed.t || cleanQuery,
            imageUrl: parsed.murl,
            sourceUrl: parsed.purl || ""
          });
        }
      } catch {
        // Skip unparseable elements
      }
    }
  });

  return images;
}