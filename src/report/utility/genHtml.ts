import fs from "fs";
import { marked } from "marked";
import hljs from "highlight.js";
import Database from "better-sqlite3";
import addAnalyze from "./markdownGen/addAnalyze.js";
import CONFIG from "../../globalConfig.js";
import addMappedJson from "./markdownGen/addMappedJson.js";
import genDataTablesPage from "./dataTables/genDataTablesPage.js";
import { createRequire } from "module";
import { printMsg, MSG } from "../../utility/printMsg.js";

declare global {
    interface Window {
        marked: any;
    }
}

/**
 * Attempts to read local DataTables assets from node_modules (for offline/self-contained reports)
 *
 * @returns An object containing the DataTables JavaScript and CSS, or null if not found
 */
export const getLocalDataTablesAssets = () => {
    try {
        const require = createRequire(import.meta.url);
        const dtJsPath = require.resolve("datatables.net/js/dataTables.min.js");
        const dtCssPath = require.resolve("datatables.net-dt/css/dataTables.dataTables.min.css");
        const js = fs.readFileSync(dtJsPath, "utf8");
        const css = fs.readFileSync(dtCssPath, "utf8");
        return { js, css } as { js: string | null; css: string | null };
    } catch (e: any) {
        printMsg(MSG.Warn, `[DataTables] Local assets not found; falling back to CDN ${e?.message || e}`);
        return { js: null, css: null } as { js: string | null; css: string | null };
    }
};

/**
 * Attempts to read local jQuery asset
 *
 * @returns The jQuery JavaScript, or null if not found
 */
export const getLocalJqueryAsset = () => {
    try {
        const require = createRequire(import.meta.url);
        // Try the direct subpath first (jQuery <4); if that fails (jQuery 4+ restricts
        // subpath exports), derive the path from the main entry.
        let jqPath: string;
        try {
            jqPath = require.resolve("jquery/dist/jquery.min.js");
        } catch {
            const mainPath = require.resolve("jquery");
            jqPath = mainPath.replace(/jquery\.js$/, "jquery.min.js");
        }
        if (!fs.existsSync(jqPath)) throw new Error("jquery.min.js not found at " + jqPath);
        const js = fs.readFileSync(jqPath, "utf8");
        return js as string | null;
    } catch {
        printMsg(MSG.Warn, "[DataTables] Local jQuery not found; falling back to CDN");
        return null as string | null;
    }
};

/**
 * Generates an HTML report based on the provided markdown and assets.
 *
 * @param analyzeMarkdown - The markdown for the analyze section
 * @param mappedJsonMarkdown - The markdown for the mapped JSON section
 * @param dataTablesHtml - The HTML for the data tables section
 * @param dtAssets - The DataTables assets (JavaScript and CSS)
 * @param jqueryJs - The jQuery JavaScript
 *
 * @returns The generated HTML report as a string
 */
const html = async (
    analyzeMarkdown: string,
    mappedJsonMarkdown: string,
    dataTablesHtml: string,
    dtAssets: { js: string | null; css: string | null },
    jqueryJs: string | null
) => {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>JS Recon Report</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github-dark.css">
  ${
      dtAssets.css
          ? `<style id="dt-inline-css">${dtAssets.css}</style>`
          : `<link rel="stylesheet" href="https://cdn.datatables.net/2.0.8/css/dataTables.dataTables.min.css">`
  }
  <style>
    h2, h3, h4 {
        cursor: pointer;
        position: relative;
        padding-left: 20px;
    }
    h2::before, h3::before, h4::before {
        content: '▼';
        position: absolute;
        left: 0;
        transition: transform 0.2s;
    }
    .collapsed::before {
        transform: rotate(-90deg);
    }
    body {
      padding-top: 80px; /* Height of the navbar */
    }
    .navbar {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      background-color: #ffffff;
      border-bottom: 1px solid #e0e0e0;
      display: flex;
      align-items: center;
      padding: 10px 20px;
      z-index: 1000;
      box-shadow: 0 2px 5px rgba(0,0,0,0.1);
    }
    .navbar-logo img {
      height: 40px;
    }
    .navbar-links {
      list-style: none;
      margin: 0 0 0 20px;
      padding: 0;
      display: flex;
      gap: 15px;
    }
    .data-table { font-size: 0.9rem; }
    pre.code-cell { white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow: auto; }
    thead tr.filter-row th { padding: 4px 6px; }
    thead tr.filter-row th input {
      width: 100%;
      padding: 4px 6px;
      border: 1px solid #ccc;
      border-radius: 4px;
      font-size: 0.85rem;
      box-sizing: border-box;
    }
    /* Column resize styles */
    table.display.data-table { table-layout: fixed; }
    table.display.data-table thead th { position: relative; }
    .th-resizer {
      position: absolute;
      right: 0;
      top: 0;
      width: 6px;
      height: 100%;
      cursor: col-resize;
      user-select: none;
      opacity: 0;
      transition: opacity 0.15s ease-in-out;
    }
    table.display.data-table thead th:hover .th-resizer { opacity: 1; }
  </style>
</head>
<body>
  <nav class="navbar">
    <div class="navbar-logo">
      <img src="https://js-recon.io/img/js-recon-logo.png" alt="JS Recon Logo">
    </div>
    <ul class="navbar-links" id="navbar-links">
      <li><a href="#home">Home</a></li>
      <li><a href="#mappedJson">Mapped JSON</a></li>
      <li><a href="#dataTables">Data Tables</a></li>
      <li><a href="#about">About</a></li>
    </ul>
  </nav>
  <div id="content"></div>
  <script id="page-data" type="application/json">
    ${JSON.stringify({
        home: await marked.parse(analyzeMarkdown),
        mappedJson: await marked.parse(mappedJsonMarkdown),
        dataTables: dataTablesHtml,
        about: `# About\n\n The documentation for this tool is available at [JS Recon Docs](https://js-recon.io/).\n\n## Version\n\nThis report is generated with JS Recon [v${CONFIG.version}](https://github.com/js-recon/js-recon/releases/tag/v${CONFIG.version}).`,
    }).replace(/</g, "\\u003c")}
  </script>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  ${
      jqueryJs
          ? `<script id="jquery-inline-js">${jqueryJs}</script>`
          : `<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>`
  }
  ${
      dtAssets.js
          ? `<script id="dt-inline-js">${dtAssets.js}</script>`
          : `<script src="https://cdn.datatables.net/2.0.8/js/dataTables.min.js"></script>`
  }
  <script>
    document.addEventListener('DOMContentLoaded', () => {
      const contentDiv = document.getElementById('content');
      const navbarLinks = document.getElementById('navbar-links');
      const pages = JSON.parse(document.getElementById('page-data').textContent);

      const isDtAvailable = () => {
        if (typeof window.DataTable !== 'undefined') return true; // ESM/global
        const $ = window.jQuery || window.$;
        return !!($ && $.fn && ($.fn.DataTable || $.fn.dataTable)); // UMD via jQuery plugin
      };

      const loadScriptOnce = (src, id) => new Promise((resolve, reject) => {
        if (document.getElementById(id)) return resolve(null);
        const s = document.createElement('script');
        s.src = src;
        s.id = id;
        s.onload = () => resolve(null);
        s.onerror = (e) => reject(e);
        document.head.appendChild(s);
      });

      const loadCssOnce = (href, id) => new Promise((resolve) => {
        if (document.getElementById(id)) return resolve(null);
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = href;
        l.id = id;
        l.onload = () => resolve(null);
        l.onerror = () => resolve(null);
        document.head.appendChild(l);
      });

      const ensureJquery = async () => {
        if (window.jQuery) return true;
        const jqCdn = [
          'https://code.jquery.com/jquery-3.7.1.min.js',
          'https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js',
          'https://unpkg.com/jquery@3.7.1/dist/jquery.min.js'
        ];
        for (let i = 0; i < jqCdn.length; i++) {
          const url = jqCdn[i];
          try {
            await loadScriptOnce(url, 'jq-cdn-' + i);
          } catch (e) {
            console.error('[jQuery] Load failed', url, e);
          }
          if (window.jQuery) {
            console.log('[jQuery] Loaded from', url);
            return true;
          }
        }
        return false;
      };

      const tryLoadDataTables = async () => {
        // Ensure jQuery is present for DataTables UMD build
        if (!isDtAvailable() && !window.jQuery) {
          const jqOk = await ensureJquery();
          if (!jqOk) {
            console.error('[DataTables] jQuery not available; cannot initialize DataTables.');
          }
        }
        const sources = [
          {
            js: 'https://cdn.datatables.net/2.0.8/js/dataTables.min.js',
            css: 'https://cdn.datatables.net/2.0.8/css/dataTables.dataTables.min.css',
            id: 'dt-cdn'
          },
          {
            js: 'https://cdn.jsdelivr.net/npm/datatables.net@2.0.8/js/dataTables.min.js',
            css: 'https://cdn.jsdelivr.net/npm/datatables.net-dt@2.0.8/css/dataTables.dataTables.min.css',
            id: 'dt-jsd'
          },
          {
            js: 'https://unpkg.com/datatables.net@2.0.8/js/dataTables.min.js',
            css: 'https://unpkg.com/datatables.net-dt@2.0.8/css/dataTables.dataTables.min.css',
            id: 'dt-unp'
          }
        ];
        for (const src of sources) {
          if (isDtAvailable()) return true;
          console.warn('[DataTables] Attempting load from', src.js);
          await loadCssOnce(src.css, src.id + '-css');
          try {
            await loadScriptOnce(src.js, src.id + '-js');
          } catch (e) {
            console.error('[DataTables] Load failed', src.js, e);
          }
          if (isDtAvailable()) {
            console.log('[DataTables] Loaded from', src.js);
            return true;
          }
        }
        return false;
      };

      const updateVisibility = () => {
        const headers = contentDiv.querySelectorAll('h2, h3, h4');
        let parentCollapsedLevels = [];
        headers.forEach(header => {
          const level = parseInt(header.tagName.substring(1));
          parentCollapsedLevels = parentCollapsedLevels.filter(l => l < level);
          if (parentCollapsedLevels.length > 0) {
            header.style.display = 'none';
          } else {
            header.style.display = '';
          }
          if (header.classList.contains('collapsed')) {
            parentCollapsedLevels.push(level);
          }
          let nextEl = header.nextElementSibling;
          while (nextEl && !nextEl.tagName.match(/^H[1-4]$/)) {
            if (parentCollapsedLevels.length > 0) {
              nextEl.style.display = 'none';
            } else {
              nextEl.style.display = '';
            }
            nextEl = nextEl.nextElementSibling;
          }
        });
      };

      const setColWidth = (tableEl, colIndex, widthPx) => {
        const nth = colIndex + 1;
        const w = Math.max(50, widthPx) + 'px';
        const th = tableEl.querySelector('thead tr:first-child th:nth-child(' + nth + ')');
        if (th) th.style.width = w;
        const filterTh = tableEl.querySelector('thead tr.filter-row th:nth-child(' + nth + ')');
        if (filterTh) filterTh.style.width = w;
        const tds = tableEl.querySelectorAll('tbody tr td:nth-child(' + nth + ')');
        tds.forEach(td => { td.style.width = w; });
      };

      const addColumnResizers = (tableEl) => {
        if (!tableEl || tableEl.dataset.resizers === '1') return;
        const ths = tableEl.querySelectorAll('thead tr:first-child th');
        ths.forEach((th, idx) => {
          if (th.querySelector('.th-resizer')) return;
          const handle = document.createElement('div');
          handle.className = 'th-resizer';
          th.appendChild(handle);
          let startX = 0;
          let startWidth = 0;
          const onMouseMove = (e) => {
            const dx = e.pageX - startX;
            setColWidth(tableEl, idx, startWidth + dx);
          };
          const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.cursor = '';
          };
          handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startX = e.pageX;
            startWidth = th.offsetWidth;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            document.body.style.cursor = 'col-resize';
          });
        });
        tableEl.dataset.resizers = '1';
        // Ensure table layout
        tableEl.style.tableLayout = 'fixed';
      };

      const initializeDataTablesIfPresent = async () => {
        try {
          // Ensure DataTables (ESM or UMD) is present
          if (!isDtAvailable()) {
            const ok = await tryLoadDataTables();
            if (!ok) {
              console.error('[DataTables] Unable to load DataTables from any CDN. Controls disabled.');
              return;
            }
          }
          const tables = contentDiv.querySelectorAll('table.data-table');
          console.log('[DataTables] Initializing', tables.length, 'table(s)');
          tables.forEach((table) => {
            if (table.dataset.dtInit === '1') return;
            const options = {
              paging: true,
              searching: true,
              ordering: true,
              orderMulti: true,
              pageLength: 25,
              autoWidth: false,
              // v1 fallback
              dom: 'lfrtip',
              // v2 layout API
              layout: {
                topStart: 'search',
                topEnd: 'pageLength',
                bottomStart: 'info',
                bottomEnd: 'paging'
              }
            };

            // Per-table column options
            if (table.id === 'findings-table') {
              options.columnDefs = [{ targets: 8, orderable: false, searchable: false }];
            } else if (table.id === 'mapped-table') {
              options.columnDefs = [{ targets: [2, 3], searchable: false }];
            }

            let dt;
            try {
              if (typeof window.DataTable !== 'undefined') {
                dt = new window.DataTable(table, options); // ESM/global style
              } else {
                const $ = window.jQuery || window.$;
                if ($ && $.fn && $.fn.DataTable) {
                  dt = $(table).DataTable(options); // UMD via jQuery plugin
                } else {
                  throw new Error('DataTables not available.');
                }
              }
            } catch (e) {
              console.error('[DataTables] Error instantiating on table#' + table.id, e);
              return;
            }

            // Add per-column filters (second header row)
            const thead = table.querySelector('thead');
            if (thead && !thead.querySelector('tr.filter-row')) {
              const headerCells = thead.querySelectorAll('tr:first-child th');
              const filterRow = document.createElement('tr');
              filterRow.className = 'filter-row';
              headerCells.forEach((th, idx) => {
                const thFilter = document.createElement('th');
                // Skip filter for non-searchable columns if specified
                const isSearchable = !options.columnDefs || !options.columnDefs.some(cd => {
                  if (Array.isArray(cd.targets)) return cd.targets.includes(idx) && cd.searchable === false;
                  return cd.targets === idx && cd.searchable === false;
                });
                if (isSearchable) {
                  const input = document.createElement('input');
                  input.type = 'text';
                  input.placeholder = 'Filter ' + (th.textContent || '').trim();
                  input.addEventListener('input', () => {
                    dt.column(idx).search(input.value).draw();
                  });
                  thFilter.appendChild(input);
                }
                filterRow.appendChild(thFilter);
              });
              thead.appendChild(filterRow);
            }
            table.dataset.dtInit = '1';
            // Attach column resizers after DataTables and filters are in place
            addColumnResizers(table);
            // Let DataTables recalc
            try { if (dt && dt.columns) dt.columns().adjust(); } catch (e) {}
          });
        } catch (e) {
          console.error('DataTables init error', e);
        }
      };

      const initializeCollapsibleHeaders = () => {
        const headers = contentDiv.querySelectorAll('h2, h3, h4');
        headers.forEach((header) => {
          if (header.tagName.toLowerCase() === 'h3') {
            header.classList.add('collapsed');
          }
          header.addEventListener('click', () => {
            header.classList.toggle('collapsed');
            updateVisibility();
          });
        });
        updateVisibility();
      };

      const renderPage = (pageName) => {
        const content = pages[pageName] || '<h2>Page Not Found: ' + pageName + '</h2>';
        if (pageName === 'home' || pageName === 'dataTables' || pageName === 'mappedJson') {
          contentDiv.innerHTML = content;
        } else {
          contentDiv.innerHTML = window.marked.parse(content);
        }
        initializeCollapsibleHeaders();
        initializeDataTablesIfPresent();
      };

      const handleHashChange = () => {
        const pageName = window.location.hash.substring(1) || 'home';
        renderPage(pageName);
      };

      navbarLinks.addEventListener('click', (event) => {
        const t = event.target;
        const a = t && (t.closest ? t.closest('a') : null);
        if (a && a.hash) {
          event.preventDefault();
          const pageName = a.hash.substring(1);
          window.location.hash = pageName;
        }
      });

      window.addEventListener('hashchange', handleHashChange);

      // Initial page load
      handleHashChange();
    });
  </script>
</body>
</html>`;
};

/**
 * Generates an HTML report based on the provided database.
 *
 * @param outputReportFile - The path to the output report file
 * @param db - The database containing the findings and mapped data
 *
 * @returns A promise that resolves when the HTML report is generated
 */
const genHtml = async (outputReportFile: string, db: Database.Database) => {
    printMsg(MSG.Header, "[i] Generating HTML report...");

    let analyzeMarkdown = `# JS Recon Report generated at ${new Date().toISOString()}\n\n`;
    let mappedJsonMarkdown = analyzeMarkdown;

    analyzeMarkdown = await addAnalyze(analyzeMarkdown, db);
    mappedJsonMarkdown = await addMappedJson(mappedJsonMarkdown, db);

    const dataTablesHtml = genDataTablesPage(db);

    const renderer = new marked.Renderer();
    renderer.code = ({ text, lang }) => {
        const language = hljs.getLanguage(lang as string) ? (lang as string) : "plaintext";
        const highlightedCode = hljs.highlight(text, { language, ignoreIllegals: true }).value;
        return `<pre><code class="hljs ${language}">${highlightedCode}</code></pre>`;
    };

    marked.setOptions({
        renderer,
        async: true,
        pedantic: false,
        gfm: true,
    });
    const dtAssets = getLocalDataTablesAssets();
    const jqueryJs = getLocalJqueryAsset();
    const renderedHtml = await html(analyzeMarkdown, mappedJsonMarkdown, dataTablesHtml, dtAssets, jqueryJs);
    fs.writeFileSync(outputReportFile, renderedHtml);

    printMsg(MSG.Run, "[✓] HTML report generated successfully");
};

export default genHtml;
