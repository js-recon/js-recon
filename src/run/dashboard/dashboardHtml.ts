import { getLocalDataTablesAssets, getLocalJqueryAsset } from "../../report/utility/genHtml.js";

/**
 * Renders the single-page live dashboard (served at `/` by server.ts). Follows the
 * same "inline local assets, fall back to CDN" pattern as ../../report/utility/genHtml.ts
 * so the dashboard works even without network access to a CDN.
 */
export const dashboardHtml = (): string => {
    const dtAssets = getLocalDataTablesAssets();
    const jqueryJs = getLocalJqueryAsset();

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>js-recon — run dashboard</title>
  ${
      dtAssets.css
          ? `<style id="dt-inline-css">${dtAssets.css}</style>`
          : `<link rel="stylesheet" href="https://cdn.datatables.net/2.0.8/css/dataTables.dataTables.min.css">`
  }
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 20px; }
    h1 { font-size: 1.3rem; }
    table.dataTable { font-size: 0.9rem; }
    .status-queued { color: #888; }
    .status-running { color: #0366d6; font-weight: bold; }
    .status-completed { color: #22863a; }
    .status-skipped { color: #b08800; }
    .status-error { color: #d73a49; font-weight: bold; }
    button.skip-btn { cursor: pointer; }
    #file-panel { display: none; margin-top: 20px; border-top: 1px solid #ddd; padding-top: 15px; }
    #file-tree { width: 30%; float: left; max-height: 500px; overflow: auto; }
    #file-content { width: 68%; float: left; margin-left: 2%; }
    #file-content pre { white-space: pre-wrap; word-break: break-word; max-height: 500px; overflow: auto; background: #f6f8fa; padding: 10px; }
    .tree-dir > span { cursor: default; font-weight: bold; }
    .tree-file { cursor: pointer; color: #0366d6; }
    .tree-file:hover { text-decoration: underline; }
    ul.tree, ul.tree ul { list-style: none; padding-left: 16px; }
  </style>
</head>
<body>
  <h1>js-recon — live run dashboard</h1>
  <table id="targets" class="display" style="width:100%">
    <thead>
      <tr><th>Target</th><th>Status</th><th>Step</th><th>Elapsed</th><th>Files</th><th>Action</th></tr>
    </thead>
    <tbody></tbody>
  </table>

  <div id="file-panel">
    <h2 id="file-panel-title"></h2>
    <div id="file-tree"></div>
    <div id="file-content"><pre>Select a file to view its contents.</pre></div>
    <div style="clear:both"></div>
  </div>

  ${jqueryJs ? `<script>${jqueryJs}</script>` : `<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>`}
  ${
      dtAssets.js
          ? `<script>${dtAssets.js}</script>`
          : `<script src="https://cdn.datatables.net/2.0.8/js/dataTables.min.js"></script>`
  }
  <script>
    const fmtElapsed = (startedAt, finishedAt) => {
      if (!startedAt) return "-";
      const end = finishedAt || Date.now();
      const secs = Math.floor((end - startedAt) / 1000);
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      return m + "m " + s + "s";
    };

    let table;
    $(document).ready(function () {
      table = $("#targets").DataTable({
        paging: false,
        searching: true,
        info: false,
        columns: [
          { data: "url" },
          { data: "status", render: (d) => '<span class="status-' + d + '">' + d + "</span>" },
          { data: "step", render: (d) => d || "-" },
          { data: null, render: (row) => fmtElapsed(row.startedAt, row.finishedAt) },
          {
            data: "hostDir",
            render: (d) => '<button class="files-btn" data-host="' + d + '">Browse</button>',
          },
          {
            data: null,
            render: (row) =>
              row.status === "running" || row.status === "queued"
                ? '<button class="skip-btn" data-host="' + row.hostDir + '">Skip</button>'
                : "-",
          },
        ],
      });
    });

    const render = (targets) => {
      table.clear();
      table.rows.add(targets).draw(false);
    };

    $(document).on("click", ".skip-btn", function () {
      const host = $(this).data("host");
      $.post("/api/targets/" + host + "/skip");
    });

    const renderTree = (entries, container) => {
      const ul = $('<ul class="tree"></ul>');
      entries.forEach((entry) => {
        const li = $("<li></li>");
        if (entry.type === "directory") {
          li.addClass("tree-dir");
          li.append($("<span></span>").text(entry.name + "/"));
          renderTree(entry.children || [], li);
        } else {
          li.addClass("tree-file").attr("data-path", entry.path).text(entry.name);
        }
        ul.append(li);
      });
      container.append(ul);
    };

    $(document).on("click", ".files-btn", function () {
      const host = $(this).data("host");
      $("#file-panel").show();
      $("#file-panel-title").text(host);
      $("#file-tree").empty();
      $("#file-content").html("<pre>Select a file to view its contents.</pre>");
      $.getJSON("/api/targets/" + host + "/files", (entries) => {
        renderTree(entries, $("#file-tree"));
        $("#file-tree").data("host", host);
      });
    });

    $(document).on("click", ".tree-file", function () {
      const host = $("#file-tree").data("host");
      const filePath = $(this).data("path");
      $.get("/api/targets/" + host + "/files/" + filePath, (content) => {
        $("#file-content").html($("<pre></pre>").text(content));
      }).fail((xhr) => {
        $("#file-content").html($("<pre></pre>").text("Error: " + xhr.responseText));
      });
    });

    const source = new EventSource("/api/events");
    source.onmessage = (event) => {
      render(JSON.parse(event.data));
    };
  </script>
</body>
</html>`;
};
