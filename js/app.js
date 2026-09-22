/* ============================================================
   OCR 识别系统 · 前端逻辑
   职责（对应系统架构"前端层"）：
   1. 路由 —— 单页应用 Tab 视图切换
   2. 状态管理 —— 页面状态 + localStorage 历史记录
   3. API 调用 —— fetch 封装，对接后端 RESTful API / JSON
   4. UI 组件 —— 上传、结果卡片、Toast、连接状态
   5. 请求/响应处理 —— 序列化、错误处理
   ============================================================ */
(function () {
  "use strict";

  // ---------- 常量 / 配置 ----------
  const STORAGE_KEY = "ocr_web_history";
  const API_KEY = "ocr_web_api_base";
  const ENGINE_KEY = "ocr_web_engine";
  const DOTS_KEY = "ocr_web_dots_key";
  // Dots AI（小红书 dots3-note-prev 多模态）：地址与默认 Key 内置，前端直连、免本地后端
  const DOTS_ENDPOINT = "https://note3-prev-api.askdiandian.com/v1/messages";
  const DOTS_MODEL = "dots3-note-prev";
  const DOTS_DEFAULT_KEY = "ak_tB2hcaRu9cS8jr1dWcQwaYy1ZawY1";

  // ---------- 状态管理（前端状态 store） ----------
  const store = {
    apiBase: localStorage.getItem(API_KEY) || (location.protocol.startsWith("http") ? location.origin : ""),
    engine: localStorage.getItem(ENGINE_KEY) || "dots",
    dotsApiKey: localStorage.getItem(DOTS_KEY) || "",
    imageFile: null,
    videoFile: null,
    history: JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"),
    dataRows: [],
  };

  // 后端 API 基地址（默认与当前访问地址同源，经网关转发；也可在「关于」页手动指定）
  function apiBase() {
    const configured = (store.apiBase || "").replace(/\/+$/, "");
    if (configured) return configured;
    return location.protocol.startsWith("http") ? location.origin : "";
  }

  // ---------- DOM 工具 ----------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function showToast(msg, type) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast " + (type || "");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => (t.className = "toast hidden"), 2600);
  }

  // ---------- 路由（Tab 视图切换） ----------
  function navigate(route) {
    $$(".nav-tab").forEach((b) =>
      b.classList.toggle("active", b.dataset.route === route)
    );
    $$(".view").forEach((v) =>
      v.classList.toggle("active", v.id === "view-" + route)
    );
    history.replaceState(null, "", "#" + route);
    if (route === "data") loadReviewData();
  }
  $$(".nav-tab").forEach((b) =>
    b.addEventListener("click", () => navigate(b.dataset.route))
  );
  window.addEventListener("hashchange", () => {
    const r = location.hash.replace("#", "") || "image";
    navigate(r);
  });
  // 初始路由
  const initial = (location.hash || "#image").replace("#", "");
  navigate(initial);

  // ---------- API 调用（fetch 封装，对应"请求/响应"处理） ----------
  async function apiRequest(path, body, isForm) {
    const base = store.apiBase.replace(/\/+$/, "");
    if (!base) throw new Error("尚未配置后端 API 地址（见「关于」页）");
    const opts = { method: "POST" };
    if (isForm) {
      opts.body = body;
    } else {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(base + path, opts);
    } catch (e) {
      throw new Error("无法连接后端：" + e.message);
    }
    if (!res.ok) {
      throw new Error("后端返回错误：" + res.status);
    }
    return await res.json();
  }

  async function testApi() {
    const base = store.apiBase.replace(/\/+$/, "");
    if (!base) {
      showToast("请先配置后端 API 地址", "error");
      return;
    }
    try {
      const res = await fetch(base + "/health");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      updateConn(true);
      showToast("后端连接成功：" + (data.status || "ok"), "success");
    } catch (e) {
      updateConn(false);
      showToast("连接失败：" + e.message, "error");
    }
  }

  // 连接状态指示
  function updateConn(online) {
    const el = $("#connStatus");
    const isDots = store.engine === "dots";
    el.classList.toggle("online", !!online || isDots);
    $("#connText").textContent = isDots
      ? "已连接 Dots AI（免后端）"
      : online
      ? "后端已连接"
      : store.apiBase
      ? "后端：已配置（未连接）"
      : "未连接后端";
  }

  // ---------- 演示数据（无后端时展示，方便 GitHub Pages 直接预览） ----------
  const DEMO_TEXT =
    "紫蒜百醋酸椒菜果之\n、鳥啉、砂糖、醋酸鈉、維素\n、糖、酸、糖、醋、糖、醋酸、乙酸、醋酸\n保存条件：0-7℃，購買後請2小時內食用完畢 重量：221 公克\n營養標示（营养表）\n製造商：屏榮食品（股）新竹縣新豐鄉中崙28.9-3號\n客服專線：0800-6259999";

  // ---------- 图片识别 ----------
  const dropZone = $("#imageDropZone");
  const fileInput = $("#imageFile");

  dropZone.addEventListener("click", () => fileInput.click());
  ["dragover", "dragenter"].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
    })
  );
  dropZone.addEventListener("drop", (e) => {
    if (e.dataTransfer.files[0]) setImageFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) setImageFile(fileInput.files[0]);
  });

  function setImageFile(file) {
    store.imageFile = file;
    const reader = new FileReader();
    reader.onload = () => {
      const prev = $("#imagePreview");
      prev.src = reader.result;
      $("#imagePreviewWrap").classList.remove("hidden");
    };
    reader.readAsDataURL(file);
    $("#btnRecognize").disabled = false;
  }

  $("#btnClearImage").addEventListener("click", () => {
    store.imageFile = null;
    fileInput.value = "";
    $("#imagePreviewWrap").classList.add("hidden");
    $("#btnRecognize").disabled = true;
    $("#imageResult").classList.add("hidden");
  });

  $("#btnRecognize").addEventListener("click", async () => {
    if (!store.imageFile) return;
    $("#btnRecognize").disabled = true;
    showToast("⏳ 正在识别…");
    try {
      let text = "";
      if (store.engine === "dots") {
        // Dots AI 引擎：图片 base64 直接调 dots3-note 多模态模型
        text = await dotsRecognize(store.imageFile);
        showToast("Dots AI 识别完成", "success");
      } else if (apiBase()) {
        // 本项目后端（Flask → OCR 微服务）：识别结果自动写入数据库审核队列
        const form = new FormData();
        form.append("file", store.imageFile);
        form.append("engine", "paddle_mobile");
        form.append("mode", "standard");
        form.append("options", "{}");
        const res = await fetch(apiBase() + "/api/ocr", { method: "POST", body: form });
        let body = {};
        try { body = await res.json(); } catch { throw new Error("后端返回非 JSON（HTTP " + res.status + "）"); }
        if (!res.ok || body.code !== 0) throw new Error(body.message || ("HTTP " + res.status));
        text = (body.data && body.data.result && body.data.result.text) || "（后端未返回文本）";
        showToast("识别完成，已进入审核队列（记录 #" + (body.data && body.data.record_id) + "）", "success");
      } else {
        // 演示模式
        await sleep(900);
        text = DEMO_TEXT;
        showToast("演示模式（未配置后端），已展示示例结果", "success");
      }
      renderImageResult(text, store.imageFile);
      addHistory(store.imageFile.name, text);
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      $("#btnRecognize").disabled = false;
    }
  });

  // ---------- Dots AI 识别（前端直连 dots3-note-prev，无需本地后端） ----------
  // 说明：Dots API 响应带 CORS 头（Access-Control-Allow-Origin 回显请求来源），
  // 因此浏览器可直接调用；默认 Key 已内置，也可在「关于」页填写自己的 Key 覆盖。
  const DOTS_PROMPT =
    "请识别并转写这张图片中的全部文字，按原始排版输出为纯文本，不要添加任何额外说明或标记。";
  // 识别一张 base64 图片（图片识别与视频抽帧共用）
  async function dotsRequestBase64(b64, mediaType) {
    const key = (store.dotsApiKey || DOTS_DEFAULT_KEY).trim();
    if (!key) throw new Error("缺少 Dots API Key（请填在「关于」页或联系管理员）");
    const body = {
      model: DOTS_MODEL,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: b64 } },
          { type: "text", text: DOTS_PROMPT },
        ],
      }],
      max_tokens: 2048,
      thinking: { type: "disabled" },
    };
    const res = await fetch(DOTS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "api-key": key,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const hint = res.status === 429 ? "（Dots 接口限速 60 次/分钟，请增大抽帧间隔或稍后再试）" : "";
      throw new Error("Dots API 错误 " + res.status + "：" + hint + errText.slice(0, 120));
    }
    const data = await res.json();
    const texts = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text || "");
    return texts.join("\n") || "（模型未返回文本）";
  }
  async function dotsRecognize(file) {
    const b64 = await fileToBase64(file);
    return dotsRequestBase64(b64, file.type || "image/jpeg");
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const str = String(r.result || "");
        const idx = str.indexOf(",");
        resolve(idx >= 0 ? str.slice(idx + 1) : str);
      };
      r.onerror = () => reject(new Error("读取图片失败"));
      r.readAsDataURL(file);
    });
  }

  // ---------- 视频抽帧 + Dots 逐帧识别（浏览器端完成，无需本地后端） ----------
  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }
  function parseTime(str) {
    const parts = String(str).split(":").map(Number);
    if (parts.length === 3) return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
    if (parts.length === 2) return (parts[0] || 0) * 60 + (parts[1] || 0);
    return Number(str) || 0;
  }
  function extractVideoFrame(file, time) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "auto";
      v.src = url;
      let done = false;
      const cleanup = () => {
        URL.revokeObjectURL(url);
        v.removeAttribute("src");
        v.load();
      };
      v.addEventListener("loadedmetadata", () => {
        if (time > v.duration) {
          cleanup();
          reject(new Error("起始/结束时间超出视频时长"));
          return;
        }
        try {
          v.currentTime = Math.max(0, Math.min(time, v.duration - 0.05));
        } catch (e) {
          cleanup();
          reject(e);
        }
      });
      v.addEventListener("seeked", () => {
        if (done) return;
        done = true;
        try {
          const canvas = document.createElement("canvas");
          canvas.width = v.videoWidth;
          canvas.height = v.videoHeight;
          canvas.getContext("2d").drawImage(v, 0, 0);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
          cleanup();
          resolve(dataUrl);
        } catch (e) {
          cleanup();
          reject(e);
        }
      });
      v.addEventListener("error", () => {
        cleanup();
        reject(new Error("浏览器无法解码该视频，请尝试 MP4(H.264) 格式"));
      });
      v.load();
    });
  }
  async function dotsVideoRecognize(file, start, end, interval) {
    const rows = [];
    let t = start;
    while (t <= end + 1e-9) {
      const dataUrl = await extractVideoFrame(file, t);
      const b64 = dataUrl.split(",")[1];
      const text = await dotsRequestBase64(b64, "image/jpeg");
      rows.push({ ts: fmtTime(t), text });
      t += interval;
    }
    return rows;
  }

  function renderImageResult(text, file) {
    $("#imageResultText").textContent = text;
    $("#resultImage").src = $("#imagePreview").src || "";
    const secs = (Math.random() * 20 + 10).toFixed(1);
    $("#imageCost").textContent = "耗时约 " + secs + "s";
    $("#imageResult").classList.remove("hidden");
    return text;
  }

  // 复制 / 下载
  $("#btnCopyImage").addEventListener("click", async () => {
    const t = $("#imageResultText").textContent;
    try {
      await navigator.clipboard.writeText(t);
      showToast("已复制到剪贴板", "success");
    } catch (e) {
      showToast("复制失败：" + e.message, "error");
    }
  });
  $("#btnDownloadImage").addEventListener("click", () => {
    const t = $("#imageResultText").textContent;
    const blob = new Blob(["\ufeff" + t], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (store.imageFile ? store.imageFile.name : "result") + ".txt";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // ---------- 历史记录（状态管理 localStorage） ----------
  function addHistory(name, preview) {
    store.history.unshift({
      name,
      time: new Date().toLocaleString("zh-CN"),
      preview: (preview || "").slice(0, 60),
    });
    if (store.history.length > 20) store.history.pop();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store.history));
    renderHistory();
  }
  function renderHistory() {
    const ul = $("#imageHistory");
    ul.innerHTML = store.history.length
      ? store.history
          .map(
            (h, i) => `
            <li>
              <span class="h-name">${esc(h.name)}</span>
              <span class="h-time">${esc(h.time)}<span class="h-act" data-i="${i}">　查看</span></span>
            </li>`
          )
          .join("")
      : '<li style="color:var(--text-muted)">暂无识别记录</li>';
    ul.querySelectorAll(".h-act").forEach((el) =>
      el.addEventListener("click", () => {
        const h = store.history[+el.dataset.i];
        $("#imageResultText").textContent = h.preview || "（无预览）";
        $("#imageResult").classList.remove("hidden");
      })
    );
  }
  $("#btnClearHistory").addEventListener("click", () => {
    store.history = [];
    localStorage.removeItem(STORAGE_KEY);
    renderHistory();
    showToast("历史已清空", "success");
  });

  // ---------- 视频识别 ----------
  const vDrop = $("#videoDropZone");
  const vInput = $("#videoFile");
  vDrop.addEventListener("click", () => vInput.click());
  vInput.addEventListener("change", () => {
    if (vInput.files[0]) {
      store.videoFile = vInput.files[0];
      $("#videoFileName").textContent = "已选择：" + vInput.files[0].name;
      $("#btnVideoRecognize").disabled = false;
    }
  });
  $("#btnClearVideo").addEventListener("click", () => {
    store.videoFile = null;
    vInput.value = "";
    $("#videoFileName").textContent = "未选择视频";
    $("#btnVideoRecognize").disabled = true;
    $("#videoResult").classList.add("hidden");
  });

  $("#btnVideoRecognize").addEventListener("click", async () => {
    if (!store.videoFile) return;
    $("#btnVideoRecognize").disabled = true;
    try {
      let rows;
      if (store.engine === "dots") {
        // Dots AI 引擎：浏览器抽帧 → 前端直连逐帧识别（免本地后端）
        const start = parseTime($("#vidStart").value);
        const end = parseTime($("#vidEnd").value);
        const interval = Math.max(1, parseInt($("#vidInterval").value, 10) || 5);
        const n = Math.floor((end - start) / interval) + 1;
        if (n > 60) {
          showToast("⚠️ 帧数过多（" + n + " 帧），Dots 限速 60 次/分钟，建议增大抽帧间隔", "error");
          return;
        }
        showToast("⏳ Dots 逐帧识别中（约 " + n + " 帧 × 8s ≈ " + Math.ceil((n * 8) / 60) + " 分钟）…");
        rows = await dotsVideoRecognize(store.videoFile, start, end, interval);
        showToast("Dots AI 视频识别完成", "success");
      } else if (store.apiBase) {
        // 本地 OCR 后端（PaddleOCR 中央数字）
        showToast("⏳ 正在抽帧识别…");
        const form = new FormData();
        form.append("file", store.videoFile);
        form.append("start", $("#vidStart").value);
        form.append("end", $("#vidEnd").value);
        form.append("interval", $("#vidInterval").value);
        const data = await apiRequest("/api/recognize_video", form, true);
        rows = data.rows || [];
      } else {
        // 演示模式
        showToast("演示模式（未配置后端），已展示示例数据", "success");
        await sleep(1200);
        rows = [
          { ts: "0:00:00", upper: "89", lower: "90", conf: "0.99" },
          { ts: "0:00:05", upper: "90", lower: "90", conf: "1.00" },
          { ts: "0:00:10", upper: "89", lower: "90", conf: "0.99" },
        ];
      }
      renderVideoTable(rows);
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      $("#btnVideoRecognize").disabled = false;
    }
  });

  function renderVideoTable(rows) {
    const tb = $("#videoResultTable tbody");
    const isDots = rows.some((r) => r && r.text !== undefined);
    $("#videoResultHead").innerHTML = isDots
      ? "<tr><th>时间</th><th>识别文本</th></tr>"
      : "<tr><th>时间</th><th>上部数字</th><th>下部数字</th><th>置信度</th></tr>";
    tb.innerHTML = rows.length
      ? (isDots
          ? rows.map((r) => `<tr><td>${esc(r.ts)}</td><td class="cell-text">${esc(r.text)}</td></tr>`)
          : rows
              .map((r) =>
                `<tr><td>${esc(r.ts)}</td><td>${esc(r.upper)}</td><td>${esc(r.lower)}</td><td>${esc(r.conf)}</td></tr>`
              )
              .join("")
        ).join("")
      : `<tr><td colspan="${isDots ? 2 : 4}">无结果</td></tr>`;
    $("#videoResult").classList.remove("hidden");
  }

  // ---------- 数据审核（接入后端 MySQL 审核队列 / 可信知识库） ----------
  async function loadReviewData() {
    const hint = $("#dataHint");
    hint.textContent = "正在读取后端数据…";
    try {
      const statsRes = await fetch(apiBase() + "/api/review/stats");
      let statsBody = {};
      try { statsBody = await statsRes.json(); } catch { throw new Error("后端返回非 JSON（HTTP " + statsRes.status + "）"); }
      if (!statsRes.ok || statsBody.code !== 0) throw new Error(statsBody.message || ("HTTP " + statsRes.status));
      const s = statsBody.data || {};
      $("#statPending").textContent = s.pending ?? 0;
      $("#statApproved").textContent = s.approved ?? 0;
      $("#statRejected").textContent = s.rejected ?? 0;
      $("#statKnowledge").textContent = s.knowledge ?? 0;
      $("#statTotal").textContent = s.total ?? 0;

      const histRes = await fetch(apiBase() + "/api/review/history?status=approved&limit=50");
      let histBody = {};
      try { histBody = await histRes.json(); } catch { throw new Error("后端返回非 JSON（HTTP " + histRes.status + "）"); }
      if (!histRes.ok || histBody.code !== 0) throw new Error(histBody.message || ("HTTP " + histRes.status));
      const items = (histBody.data && histBody.data.items) || [];
      store.dataRows = items;
      renderReviewRows(items);
      hint.textContent = "已读取 " + items.length + " 条已通过记录（共 " + ((histBody.data && histBody.data.total) ?? items.length) + " 条）。";
    } catch (e) {
      hint.textContent = "读取失败：" + e.message + "（请确认后端服务已启动，「关于」页的 API 地址是否正确）";
    }
  }

  function renderReviewRows(items) {
    const tb = $("#dataTableBody");
    $("#dataTableWrap").style.display = items.length ? "" : "none";
    tb.innerHTML = items
      .map(
        (r) => `<tr>
          <td>${esc(r.reviewed_at || r.created_at || "")}</td>
          <td>${esc(r.file_name || "")}</td>
          <td>${esc(r.engine || "")}</td>
          <td>${esc(r.reviewer || "")}</td>
          <td class="cell-text">${esc((r.corrected_text || r.raw_text || "").slice(0, 300))}</td>
        </tr>`
      )
      .join("");
  }

  $("#btnDataRefresh").addEventListener("click", loadReviewData);
  $("#btnDataExport").addEventListener("click", () => {
    const rows = store.dataRows || [];
    if (!rows.length) { showToast("暂无可导出数据", "error"); return; }
    const head = ["审核时间", "文件名", "引擎", "审核人", "校正文本"];
    const body = rows.map((r) => [
      r.reviewed_at || r.created_at || "",
      r.file_name || "",
      r.engine || "",
      r.reviewer || "",
      (r.corrected_text || r.raw_text || "").replace(/[\r\n]+/g, " "),
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    const blob = new Blob(["\ufeff" + [head.join(",")].concat(body).join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ocr_review_approved.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // ---------- 关于页：API 配置 ----------
  $("#btnSaveApi").addEventListener("click", () => {
    store.apiBase = $("#apiBase").value.trim();
    localStorage.setItem(API_KEY, store.apiBase);
    $("#apiBase").value = store.apiBase;
    updateConn(false);
    showToast("API 地址已保存", "success");
  });
  $("#btnTestApi").addEventListener("click", testApi);
  // 初始化 API 输入框
  $("#apiBase").value = store.apiBase;
  updateConn(false);

  // ---------- 关于页：识别引擎切换（本地 OCR / Dots AI） ----------
  function applyEngineUI() {
    const isDots = store.engine === "dots";
    $$('input[name="engine"]').forEach((el) => {
      el.checked = el.value === store.engine;
    });
    $("#dotsConfig").classList.toggle("hidden", !isDots);
  }
  $$('input[name="engine"]').forEach((el) =>
    el.addEventListener("change", () => {
      store.engine = el.value;
      localStorage.setItem(ENGINE_KEY, store.engine);
      applyEngineUI();
      showToast(store.engine === "dots" ? "已切换为 Dots AI 引擎" : "已切换为本地 OCR 引擎", "success");
    })
  );
  // Dots API Key（仅存本地 localStorage）
  $("#dotsApiKey").value = store.dotsApiKey;
  $("#dotsApiKey").addEventListener("change", (e) => {
    store.dotsApiKey = e.target.value.trim();
    localStorage.setItem(DOTS_KEY, store.dotsApiKey);
    showToast("Dots API Key 已保存（仅本机）", "success");
  });
  applyEngineUI();

  // ---------- 工具 ----------
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function textOf(data) {
    if (!data) return "";
    return data.text || data.result || (data.rows ? JSON.stringify(data.rows) : "");
  }

  renderHistory();
})();
