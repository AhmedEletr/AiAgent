export interface DocTheme {
  primaryColor: string;
  accentColor: string;
  frameColor: string;
  fontFamily: string;
  fontSize: string;
  imageSize: string;
}

export interface ContentPage {
  pageNumber: number;
  title: string;
  categoryTag: string;
  iconClass: string; // Boxicon class (e.g. 'bx bx-dna')
  imageCorner: "top-right" | "bottom-left" | "top-left" | "bottom-right";
  imageUrl: string;
  leadParagraph: string;
  subheading1: string;
  bodyParagraph1: string;
  subheading2: string;
  bodyParagraph2: string;
  keyTakeaways: string[];
  footerNote: string;
}

export interface DocSource {
  type: "website" | "paper" | "book" | "journal";
  title: string;
  urlOrCitation: string;
  description: string;
}

export interface AstroDocState {
  docId: string;
  version: number;
  theme: DocTheme;
  cover: {
    mainTitle: string;
    subtitle: string;
    badge: string;
    date: string;
    coverImageUrl: string;
    executiveSummary: string;
    insights: string[];
  };
  pages: ContentPage[];
  sources: DocSource[];
}

function extractDomain(url: string): string {
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    return parsed.hostname;
  } catch {
    return "nature.com";
  }
}

export function generateAstroHtml(doc: AstroDocState): string {
  const { theme, cover, pages, sources } = doc;

  // Build Pages 2 to 14 (Dense Content Pages)
  const contentPagesHtml = pages.map((page) => {
    const floatStyle = page.imageCorner.includes("right")
      ? "float: right; margin: 0 0 16px 22px;"
      : "float: left; margin: 0 22px 16px 0;";

    const takeawaysHtml = page.keyTakeaways
      .map(
        (point) => `
        <div class="takeaway-item">
          <i class='bx bx-check-shield icon-accent'></i>
          <span>${point}</span>
        </div>`
      )
      .join("");

    return `
    <div class="page content-page">
      <div class="page-frame">
        <header class="page-header">
          <div class="header-left">
            <i class='${page.iconClass} header-icon'></i>
            <span class="header-tag">${page.categoryTag}</span>
          </div>
          <span class="header-doc-title">${cover.mainTitle}</span>
        </header>

        <main class="page-content">
          <h2 class="page-title">${page.title}</h2>
          
          <div class="body-wrapper">
            <!-- 1:1 Aspect Ratio Image with Fallback -->
            <div class="image-container" style="${floatStyle}">
              <img 
                src="${page.imageUrl}" 
                alt="${page.title}" 
                class="square-image" 
                loading="eager"
                onerror="this.onerror=null; this.src='https://images.unsplash.com/photo-1532094349884-543bc11b234d?w=600&q=80';"
              />
            </div>

            <!-- Lead Overview Text -->
            <p class="lead-text">${page.leadParagraph}</p>
            
            <!-- In-Depth Section 1 -->
            <h3 class="section-subheading">
              <i class='bx bx-chevron-right icon-accent'></i> ${page.subheading1}
            </h3>
            <p class="body-text">${page.bodyParagraph1}</p>

            <!-- In-Depth Section 2 (Doubles the Text Density) -->
            <h3 class="section-subheading">
              <i class='bx bx-chevron-right icon-accent'></i> ${page.subheading2}
            </h3>
            <p class="body-text">${page.bodyParagraph2}</p>
          </div>

          <!-- Pushed to bottom right above footer -->
          <div class="takeaways-box">
            <div class="takeaways-header">
              <i class='bx bx-layer icon-accent'></i> Core Principles & Clinical Takeaways
            </div>
            <div class="takeaways-grid">
              ${takeawaysHtml}
            </div>
          </div>
        </main>

        <!-- Strictly Stuck to the Bottom -->
        <footer class="page-footer">
          <span>${page.footerNote || "AstroMind A1 Educational Platform"}</span>
          <span class="page-counter">Page ${page.pageNumber} of 15</span>
        </footer>
      </div>
    </div>`;
  }).join("\n");

  // Build Page 15 (Sources & References)
  const sourcesHtml = (sources || []).map((s) => {
    let iconOrFavicon = "";

    if (s.type === "website") {
      const domain = extractDomain(s.urlOrCitation);
      iconOrFavicon = `<img src="https://www.google.com/s2/favicons?domain=${domain}&sz=64" alt="${domain}" class="source-favicon" />`;
    } else if (s.type === "paper") {
      iconOrFavicon = `<i class='bx bx-file-blank source-type-icon'></i>`;
    } else if (s.type === "book") {
      iconOrFavicon = `<i class='bx bx-book-bookmark source-type-icon'></i>`;
    } else {
      iconOrFavicon = `<i class='bx bx-certification source-type-icon'></i>`;
    }

    const isLink = s.urlOrCitation.startsWith("http");

    return `
    <div class="source-card">
      <div class="source-header">
        <div class="source-icon-wrapper">${iconOrFavicon}</div>
        <div class="source-title-block">
          <h4 class="source-title">${s.title}</h4>
          ${
            isLink
              ? `<a href="${s.urlOrCitation}" class="source-url" target="_blank">${s.urlOrCitation}</a>`
              : `<span class="source-url">${s.urlOrCitation}</span>`
          }
        </div>
      </div>
      <p class="source-desc">${s.description}</p>
    </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${cover.mainTitle}</title>
  <link href='https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css' rel='stylesheet'>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap');

    :root {
      --primary: ${theme.primaryColor || "#0F172A"};
      --accent: ${theme.accentColor || "#2563EB"};
      --frame-border: ${theme.frameColor || "#94A3B8"};
      --font-body: ${theme.fontFamily || "'Inter', sans-serif"};
      --base-font-size: ${theme.fontSize || "12px"};
      --image-dimension: ${theme.imageSize || "210px"};
      --bg-white: #FFFFFF;
      --card-bg: #F8FAFC;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    @page {
      size: A4 portrait;
      margin: 0;
    }

    body {
      background: #E2E8F0;
      font-family: var(--font-body);
      font-size: var(--base-font-size);
      color: #334155;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    .page {
      width: 210mm;
      height: 297mm;
      position: relative;
      background: var(--bg-white);
      margin: 0 auto;
      overflow: hidden;
      page-break-after: always;
      page-break-inside: avoid;
    }

    /* ── BOLDER FRAME DESIGN ── */
    .page-frame {
      position: absolute;
      inset: 8mm; /* Tight edge margins for maximum vertical content room */
      border: 2.5px solid var(--frame-border); /* Bolder line weight */
      border-radius: 16px;
      padding: 22px 26px;
      display: flex;
      flex-direction: column;
      justify-content: space-between; /* Strictly pushes footer to the bottom */
      overflow: hidden;
    }

    /* ── COVER PAGE ── */
    .cover-frame {
      border: 3px solid var(--primary);
      padding: 30px;
    }

    .cover-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #EFF6FF;
      color: var(--accent);
      padding: 6px 14px;
      border-radius: 20px;
      font-weight: 700;
      font-size: 11px;
      letter-spacing: 0.5px;
      align-self: flex-start;
    }

    .cover-title {
      font-family: 'Plus Jakarta Sans', sans-serif;
      font-size: 33px;
      color: var(--primary);
      line-height: 1.2;
      margin-top: 12px;
      font-weight: 800;
    }

    .cover-subtitle {
      font-size: 13.5px;
      color: #64748B;
      margin-top: 6px;
      line-height: 1.5;
    }

    .cover-hero-image {
      width: 100%;
      height: 260px;
      object-fit: cover;
      border-radius: 12px;
      margin: 16px 0;
      border: 2px solid var(--frame-border);
    }

    .cover-card {
      background: var(--card-bg);
      border: 1.5px solid var(--frame-border);
      border-radius: 12px;
      padding: 16px 20px;
    }

    .cover-card h4 {
      color: var(--primary);
      font-size: 12.5px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .cover-insights-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px 14px;
      margin-top: 10px;
    }

    .cover-insight-item {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      font-size: 11px;
      color: #475569;
    }

    /* ── CONTENT PAGES ── */
    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1.5px solid var(--frame-border);
      padding-bottom: 8px;
      margin-bottom: 12px;
      font-size: 9.5px;
      color: #64748B;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 700;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--accent);
    }

    .page-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .page-title {
      font-family: 'Plus Jakarta Sans', sans-serif;
      font-size: 20px;
      color: var(--primary);
      margin-bottom: 10px;
      font-weight: 800;
    }

    .body-wrapper {
      flex: 1;
      overflow: hidden;
    }

    /* 1:1 Aspect Ratio Square Corner Image */
    .image-container {
      width: var(--image-dimension);
      height: var(--image-dimension);
      border-radius: 12px;
      overflow: hidden;
      border: 2px solid var(--frame-border);
      box-shadow: 0 4px 14px rgba(0,0,0,0.06);
      background: #F1F5F9;
    }

    .square-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .lead-text {
      font-size: var(--base-font-size);
      line-height: 1.6;
      color: #1E293B;
      text-align: justify;
      margin-bottom: 10px;
      font-weight: 500;
    }

    .section-subheading {
      font-size: 12px;
      color: var(--primary);
      margin: 10px 0 4px 0;
      display: flex;
      align-items: center;
      gap: 4px;
      font-weight: 700;
    }

    .body-text {
      font-size: calc(var(--base-font-size) - 0.5px);
      line-height: 1.55;
      color: #475569;
      text-align: justify;
      margin-bottom: 10px;
    }

    /* Key Takeaways Bottom Card */
    .takeaways-box {
      background: var(--card-bg);
      border: 1.5px solid var(--frame-border);
      border-radius: 10px;
      padding: 12px 16px;
      margin-top: auto; /* Pushes card down right above footer */
      margin-bottom: 12px;
    }

    .takeaways-header {
      font-size: 10.5px;
      font-weight: 800;
      color: var(--primary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
    }

    .takeaways-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px 12px;
    }

    .takeaway-item {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      font-size: 10px;
      color: #334155;
      line-height: 1.35;
    }

    /* ── STICKY FOOTER ── */
    .page-footer {
      border-top: 1.5px solid var(--frame-border);
      padding-top: 10px;
      margin-top: 0;
      display: flex;
      justify-content: space-between;
      font-size: 9.5px;
      color: #64748B;
      font-weight: 600;
    }

    /* ── PAGE 15: SOURCES ── */
    .sources-container {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 8px;
      overflow: hidden;
    }

    .source-card {
      background: var(--card-bg);
      border: 1.5px solid var(--frame-border);
      border-radius: 10px;
      padding: 10px 14px;
    }

    .source-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 4px;
    }

    .source-icon-wrapper {
      width: 26px;
      height: 26px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      background: #FFFFFF;
      border: 1px solid var(--frame-border);
      flex-shrink: 0;
    }

    .source-favicon {
      width: 16px;
      height: 16px;
      border-radius: 3px;
    }

    .source-type-icon {
      font-size: 16px;
      color: var(--accent);
    }

    .source-title-block {
      overflow: hidden;
    }

    .source-title {
      font-size: 11.5px;
      font-weight: 700;
      color: var(--primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .source-url {
      font-size: 10px;
      color: var(--accent);
      text-decoration: none;
      word-break: break-all;
    }

    .source-desc {
      font-size: 10.5px;
      line-height: 1.45;
      color: #64748B;
      margin-top: 2px;
    }

    .icon-accent {
      color: var(--accent);
      font-size: 14px;
      flex-shrink: 0;
      margin-top: 1px;
    }

    @media print {
      body { background: transparent; }
      .page { margin: 0; box-shadow: none; }
    }
  </style>
</head>
<body>

  <!-- ═══ PAGE 1: COVER PAGE ═══ -->
  <div class="page cover-page">
    <div class="page-frame cover-frame">
      <div>
        <div class="cover-badge">
          <i class='bx bx-award'></i> ${cover.badge || "ACADEMIC DOSSIER"}
        </div>
        <h1 class="cover-title">${cover.mainTitle}</h1>
        <p class="cover-subtitle">${cover.subtitle}</p>
      </div>

      <img src="${cover.coverImageUrl}" alt="Cover Hero" class="cover-hero-image" />

      <div class="cover-card">
        <h4><i class='bx bx-compass'></i> Grounded Executive Briefing</h4>
        <p style="font-size: 11.5px; line-height: 1.5; color: #475569;">${cover.executiveSummary}</p>
        
        <div class="cover-insights-grid">
          ${(cover.insights || []).map((ins) => `
            <div class="cover-insight-item">
              <i class='bx bx-check-circle icon-accent'></i>
              <span>${ins}</span>
            </div>
          `).join("")}
        </div>
      </div>

      <div class="page-footer">
        <span>AstroMind A1 · Verified Research Publication</span>
        <span>${cover.date || new Date().toLocaleDateString()}</span>
      </div>
    </div>
  </div>

  <!-- ═══ PAGES 2 TO 14: CONTENT PAGES ═══ -->
  ${contentPagesHtml}

  <!-- ═══ PAGE 15: SOURCES & VERIFIED REFERENCES ═══ -->
  <div class="page content-page">
    <div class="page-frame">
      <header class="page-header">
        <div class="header-left">
          <i class='bx bx-library header-icon'></i>
          <span class="header-tag">GROUNDED CITATIONS</span>
        </div>
        <span class="header-doc-title">${cover.mainTitle}</span>
      </header>

      <main class="page-content">
        <h2 class="page-title">Verified Sources & Academic Literature</h2>
        <p class="lead-text" style="margin-bottom: 12px;">
          This educational dossier is grounded in real-time academic literature, institutional web databases, and peer-reviewed documentation collected via AstroSearch to prevent hallucination and bias.
        </p>

        <div class="sources-container">
          ${sourcesHtml}
        </div>
      </main>

      <footer class="page-footer">
        <span>AstroMind A1 Grounded Research Engine</span>
        <span class="page-counter">Page 15 of 15</span>
      </footer>
    </div>
  </div>

</body>
</html>`;
}