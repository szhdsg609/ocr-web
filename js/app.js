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

  // 审核台状态筛选（声明必须提前：navigate() 在初始化阶段就会读这两个值）
  const REVIEW_STATUS_LABEL = { pending: "待审核", approved: "已通过", rejected: "已拒绝" };
  let reviewFilter = "pending";
  const REVIEW_TOKEN_KEY = "ocr_web_review_token";

  // ---------- 状态管理（前端状态 store） ----------
  const store = {
    apiBase: localStorage.getItem(API_KEY) || (location.protocol.startsWith("http") ? location.origin : ""),
    engine: localStorage.getItem(ENGINE_KEY) || "dots",
    dotsApiKey: localStorage.getItem(DOTS_KEY) || "",
    reviewToken: localStorage.getItem(REVIEW_TOKEN_KEY) || "",
    imageFile: null,
    videoFile: null,
    history: JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"),
    dataRows: [],
  };

  // 后端 API 基地址：
  // - 「关于」页手动配置优先（GitHub Pages 等纯静态托管必须配置）
  // - 未配置时：经 8082 网关（同源有 /api 反代）可用同源
  function apiBase() {
    const configured = (store.apiBase || "").replace(/\/+$/, "");
    if (configured) return configured;
    if (/\.github\.io$/i.test(location.hostname)) return ""; // 静态托管无后端
    return location.protocol.startsWith("http") ? location.origin : "";
  }

  const NO_BACKEND_HINT =
    "未配置后端地址。当前页面是纯静态托管（GitHub Pages），没有 /api 接口；" +
    "请在「关于」页填写后端地址（本机网关 http://127.0.0.1:8082，或云端地址）后重试。";

  // 统一后端请求：自动处理「未配置」「返回网页而非 JSON」等情况，给出可读提示
  async function apiFetch(path, options) {
    const base = apiBase();
    // 静态托管（GitHub Pages）上没有后端服务：同源地址也直接给出配置提示
    if (!base || (/\.github\.io$/i.test(location.hostname) && base === location.origin)) {
      throw new Error(NO_BACKEND_HINT);
    }
    let res;
    try {
      res = await fetch(base + path, options);
    } catch (e) {
      throw new Error("无法连接后端（" + base + "）：" + e.message);
    }
    const raw = await res.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      const isHtml = (res.headers.get("content-type") || "").includes("html");
      throw new Error(
        "后端返回的不是 JSON（HTTP " + res.status + "）。" +
          (isHtml
            ? "该地址返回的是网页，说明它不是 OCR 后端——请在「关于」页检查后端地址。"
            : "请确认后端服务是否正常运行。")
      );
    }
    if (!res.ok || (body && typeof body.code !== "undefined" && body.code !== 0)) {
      throw new Error((body && body.message) || ("HTTP " + res.status));
    }
    return body;
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
    if (route === "data") { loadReviewData(); loadPendingList(); }
    if (route === "eval") loadEvalRecords();
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
    const startedAt = Date.now();
    try {
      let text = "";
      if (store.engine === "dots") {
        // Dots AI 引擎：图片 base64 直接调 dots3-note 多模态模型
        text = await dotsRecognize(store.imageFile);
        // 识别结果与原图同步进入后端审核队列，使数据审核/评测对比跟着更新
        const saved = await importToReviewQueue(store.imageFile, text, DOTS_MODEL);
        showToast(
          saved
            ? "Dots AI 识别完成，已进入审核队列（记录 #" + saved.record_id + "）"
            : "Dots AI 识别完成（未配置后端，未进入审核队列）",
          "success"
        );
      } else if (apiBase()) {
        // 本项目后端（Flask → OCR 微服务）：识别结果自动写入数据库审核队列
        const form = new FormData();
        form.append("file", store.imageFile);
        form.append("engine", "paddle_mobile");
        form.append("mode", "standard");
        form.append("options", "{}");
        const body = await apiFetch("/api/ocr", { method: "POST", body: form });
        text = (body.data && body.data.result && body.data.result.text) || "（后端未返回文本）";
        showToast("识别完成，已进入审核队列（记录 #" + (body.data && body.data.record_id) + "）", "success");
      } else {
        // 演示模式
        await sleep(900);
        text = DEMO_TEXT;
        showToast("演示模式（未配置后端），已展示示例结果", "success");
      }
      const costSeconds = (Date.now() - startedAt) / 1000;
      renderImageResult(text, store.imageFile, costSeconds);
      addHistory(store.imageFile.name, text, costSeconds);
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

  // 把前端直连识别结果（含原图）导入后端审核队列，
  // 保证「数据审核 / 审核台 / 评测对比」与识别过的图片数量同步
  async function importToReviewQueue(file, text, engine) {
    if (!apiBase() || !file || !text) return null;
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("text", text);
      form.append("engine", engine || "frontend-direct");
      form.append("mode", "standard");
      const body = await apiFetch("/api/review/import", { method: "POST", body: form });
      return body.data || null;
    } catch (e) {
      console.warn("导入审核队列失败：", e.message);
      return null;
    }
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

  function renderImageResult(text, file, seconds) {
    $("#imageResultText").textContent = text;
    $("#resultImage").src = $("#imagePreview").src || "";
    const cost = typeof seconds === "number" ? seconds.toFixed(1) : "—";
    $("#imageCost").textContent = "耗时约 " + cost + "s";
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
  //  保存完整识别文本（text），不再只存截断预览；同时记录真实耗时
  function addHistory(name, text, seconds) {
    store.history.unshift({
      name,
      time: new Date().toLocaleString("zh-CN"),
      text: text || "",
      cost: typeof seconds === "number" ? Number(seconds.toFixed(1)) : null,
      preview: (text || "").slice(0, 60), // 兼容旧版字段
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
        if (!h) return;
        if (h.text) {
          $("#imageResultText").textContent = h.text;
          $("#imageCost").textContent =
            typeof h.cost === "number" ? "历史记录 · 耗时约 " + h.cost + "s" : "历史记录";
        } else {
          // 旧版本只保存了 60 字预览，无法恢复全文
          $("#imageResultText").textContent =
            (h.preview || "（无预览）") +
            "\n\n（此条历史来自旧版本，仅保存了预览；请重新识别以保存完整结果）";
          $("#imageCost").textContent = "旧版历史记录";
        }
        $("#imageResult").classList.remove("hidden");
        showToast("已载入历史记录：" + h.name, "success");
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
      const statsBody = await apiFetch("/api/review/stats");
      const s = statsBody.data || {};
      $("#statPending").textContent = s.pending ?? 0;
      $("#statApproved").textContent = s.approved ?? 0;
      $("#statRejected").textContent = s.rejected ?? 0;
      $("#statKnowledge").textContent = s.knowledge ?? 0;
      $("#statTotal").textContent = s.total ?? 0;

      const histBody = await apiFetch("/api/review/history?status=approved&limit=50");
      const items = (histBody.data && histBody.data.items) || [];
      store.dataRows = items;
      renderReviewRows(items);
      hint.textContent = "已读取 " + items.length + " 条已通过记录（共 " + ((histBody.data && histBody.data.total) ?? items.length) + " 条）。";
    } catch (e) {
      hint.textContent = !apiBase()
        ? "当前是纯静态托管页面（无后端）。请改用本机地址 http://127.0.0.1:8082/ 查看审核数据与可信知识库。"
        : "读取失败：" + e.message;
    }
  }

  function renderReviewRows(items) {
    const tb = $("#dataTableBody");
    $("#dataTableWrap").style.display = items.length ? "" : "none";
    const empty = $("#dataTableEmpty");
    if (empty) empty.style.display = items.length ? "none" : "";
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

  // ---------- 审核台：填写标准结果 ----------
  let currentReviewId = null;

  function syncReviewFilterUI() {
    $$(".review-filters .chip").forEach((b) =>
      b.classList.toggle("active", b.dataset.status === reviewFilter)
    );
    const label = $("#listFilterLabel");
    if (label) label.textContent = reviewFilter === "all" ? "全部记录" : REVIEW_STATUS_LABEL[reviewFilter];
  }

  // 审核台顶部显示令牌配置状态，避免同学不知道为何提交失败
  function updateReviewTokenState() {
    const el = $("#reviewTokenState");
    if (!el) return;
    if ((store.reviewToken || "").trim()) {
      el.textContent = "✅ 审核令牌已配置（仅存本机浏览器），可直接提交。";
      el.style.color = "";
    } else {
      el.textContent = "⚠️ 尚未配置审核令牌 —— 请到「📘 关于」页的「🔐 审核令牌」填写并保存，否则无法提交。";
      el.style.color = "#fca5a5";
    }
  }

  async function loadPendingList(status) {
    const ul = $("#pendingList");
    if (!ul) return;
    if (status) reviewFilter = status;
    syncReviewFilterUI();
    updateReviewTokenState();
    try {
      const body = await apiFetch(
        "/api/review/pending?status=" + encodeURIComponent(reviewFilter) + "&page=1&page_size=50"
      );
      const items = (body.data && body.data.items) || [];
      $("#pendingCount").textContent = (body.data && body.data.total) ?? items.length;
      ul.innerHTML = items.length
        ? items
            .map(
              (r) => `
            <li data-id="${r.id}">
              <span class="r-name">${esc(r.file_name)}</span>
              <span class="r-meta"><span class="status-chip ${esc(r.status || "")}">${esc(REVIEW_STATUS_LABEL[r.status] || r.status || "-")}</span>${esc(r.engine || "")} · ${esc(r.created_at || "")}</span>
            </li>`
            )
            .join("")
        : '<li class="hint">该分类下暂无记录</li>';
      ul.querySelectorAll("li[data-id]").forEach((li) =>
        li.addEventListener("click", () => selectReviewRecord(+li.dataset.id))
      );
    } catch (e) {
      const needBackend = !apiBase();
      ul.innerHTML = needBackend
        ? `<li class="hint">当前是纯静态托管页面（无后端），无法填写标准答案。<br>
             请改用<b>本机地址</b>打开：
             <a href="http://127.0.0.1:8082/" target="_blank" rel="noopener">http://127.0.0.1:8082/</a>
             （数据库与后端运行在你自己电脑上）</li>`
        : `<li class="hint">读取失败：${esc(e.message)}</li>`;
    }
  }

  async function selectReviewRecord(id) {
    currentReviewId = id;
    $$("#pendingList li").forEach((li) => li.classList.toggle("active", +li.dataset.id === id));
    $("#reviewEmpty").classList.add("hidden");
    $("#reviewBody").classList.remove("hidden");
    $("#reviewImage").src = (apiBase() || "") + "/api/review/" + id + "/file";
    $("#reviewText").value = "加载中…";
    try {
      const body = await apiFetch("/api/review/" + id);
      const d = body.data || {};
      const statusText = REVIEW_STATUS_LABEL[d.status] || d.status || "-";
      $("#reviewMeta").textContent = `#${d.id} · ${d.file_name} · 引擎 ${d.engine || "-"} · 模式 ${d.mode || "-"} · ${d.created_at || ""}`;
      const hint = $("#reviewStatusHint");
      if (hint) {
        hint.textContent =
          d.status === "pending"
            ? `当前状态：${statusText}`
            : `当前状态：${statusText}（${d.reviewer || "-"} · ${d.reviewed_at || "-"}）· 可修改后重新提交或改判`;
      }
      // 已审核记录回填「标准结果」便于直接修改；未审核则回填原始识别文本
      $("#reviewText").value = d.corrected_text || d.raw_text || "";
    } catch (e) {
      $("#reviewText").value = "读取失败：" + e.message;
    }
  }

  async function submitReview(status) {
    if (!currentReviewId) { showToast("请先在左侧选择一条记录", "error"); return; }
    const token = (store.reviewToken || "").trim();
    if (!token) { showToast("请先在「关于」页填写并保存审核令牌", "error"); return; }
    const payload = {
      record_id: currentReviewId,
      status,
      reviewed_text: $("#reviewText").value,
      reviewed_by: ($("#reviewUser").value || "").trim() || "reviewer",
      review_note: ($("#reviewNote").value || "").trim(),
    };
    try {
      const body = await apiFetch("/api/review/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Review-Token": token },
        body: JSON.stringify(payload),
      });
      showToast(body.message || (status === "approved" ? "已通过" : "已拒绝"), "success");
      await Promise.all([loadPendingList(), loadReviewData()]);
      // 记录若仍在当前筛选列表中则保持选中，方便继续修改或改判
      const stillListed = Array.from($$("#pendingList li[data-id]")).some(
        (li) => +li.dataset.id === currentReviewId
      );
      if (stillListed) {
        await selectReviewRecord(currentReviewId);
      } else {
        currentReviewId = null;
        $("#reviewBody").classList.add("hidden");
        $("#reviewEmpty").classList.remove("hidden");
      }
    } catch (e) {
      const msg = /令牌|UNAUTHORIZED/i.test(e.message)
        ? "审核令牌无效或未配置 —— 请到「关于」页重新填写并保存后再提交"
        : e.message;
      showToast("提交失败：" + msg, "error");
    }
  }

  $$(".review-filters .chip").forEach((btn) =>
    btn.addEventListener("click", () => loadPendingList(btn.dataset.status))
  );

  $("#btnApprove").addEventListener("click", () => submitReview("approved"));
  $("#btnReject").addEventListener("click", () => submitReview("rejected"));

  // ---------- 评测对比（识别结果 vs 标准结果） ----------
  async function loadEvalRecords() {
    const sel = $("#evalRecord");
    if (!sel) return;
    try {
      const body = await apiFetch("/api/eval/records?limit=200");
      const items = (body.data && body.data.items) || [];
      sel.innerHTML = items.length
        ? items
            .map((r) => `<option value="${r.record_id}">#${r.record_id} · ${esc(r.file_name)} · ${esc(r.engine || "")}</option>`)
            .join("")
        : '<option value="">（暂无已填写标准结果的样本）</option>';
      $("#evalHint").textContent = items.length
        ? `共 ${items.length} 个可评测样本，选择后点击「开始对比」。`
        : "还没有已审核并填写标准结果的记录——请先在「数据审核」→「审核台」填写标准结果。";
    } catch (e) {
      sel.innerHTML = '<option value="">读取失败</option>';
      $("#evalHint").textContent = !apiBase()
        ? "当前是纯静态托管页面（无后端）。请改用本机地址 http://127.0.0.1:8082/ 使用评测对比（数据库在本机）。"
        : "读取失败：" + e.message;
    }
  }

  async function runEvalCompare() {
    const id = $("#evalRecord").value;
    if (!id) { showToast("请先选择样本", "error"); return; }
    try {
      const body = await apiFetch("/api/review/" + id + "/compare");
      const d = body.data || {};
      $("#evalAccuracy").textContent = (((d.char_accuracy || 0) * 100).toFixed(2)) + "%";
      $("#evalSimilarity").textContent = (((d.similarity || 0) * 100).toFixed(2)) + "%";
      $("#evalDistance").textContent = d.edit_distance ?? "–";
      $("#evalLineMatch").textContent = (((d.line_match_rate || 0) * 100).toFixed(2)) + "%";
      $("#evalMetrics").style.display = "";
      renderLineDiff(d.line_diff || []);
      $("#diffGrid").classList.remove("hidden");
      $("#evalHint").textContent = `样本 #${d.record_id} · ${d.file_name} · 引擎 ${d.engine || "-"} · 标准 ${d.standard_chars || 0} 字 / 识别 ${d.recognized_chars || 0} 字 · 行匹配 ${d.matched_lines || 0}/${d.standard_lines || 0}`;
    } catch (e) {
      showToast("对比失败：" + e.message, "error");
    }
  }

  function renderLineDiff(ops) {
    const left = [];
    const right = [];
    ops.forEach((op) => {
      const stdLines = op.standard || [];
      const recLines = op.recognized || [];
      if (op.tag === "equal") {
        stdLines.forEach((line) => left.push(`<div class="dl dl-equal">${esc(line)}</div>`));
        recLines.forEach((line) => right.push(`<div class="dl dl-equal">${esc(line)}</div>`));
      } else if (op.tag === "replace") {
        const n = Math.max(stdLines.length, recLines.length);
        for (let i = 0; i < n; i++) {
          left.push(`<div class="dl dl-replace">${esc(stdLines[i] ?? "")}</div>`);
          right.push(`<div class="dl dl-replace">${esc(recLines[i] ?? "")}</div>`);
        }
      } else if (op.tag === "delete") {
        stdLines.forEach((line) => {
          left.push(`<div class="dl dl-delete">${esc(line)}</div>`);
          right.push(`<div class="dl dl-empty">（识别缺失）</div>`);
        });
      } else if (op.tag === "insert") {
        recLines.forEach((line) => {
          right.push(`<div class="dl dl-insert">${esc(line)}</div>`);
          left.push(`<div class="dl dl-empty">（标准无此行）</div>`);
        });
      }
    });
    $("#diffRecognized").innerHTML = right.join("") || '<div class="dl">（无内容）</div>';
    $("#diffStandard").innerHTML = left.join("") || '<div class="dl">（无内容）</div>';
  }

  async function loadEvalSummary() {
    try {
      const body = await apiFetch("/api/eval/summary");
      const d = body.data || {};
      const engines = d.engines || [];
      $("#evalSummaryBody").innerHTML = engines.length
        ? engines
            .map(
              (e) => `<tr>
            <td>${esc(e.engine)}</td>
            <td>${e.samples}</td>
            <td>${(e.avg_char_accuracy * 100).toFixed(2)}%</td>
            <td>${(e.best * 100).toFixed(2)}%</td>
            <td>${(e.worst * 100).toFixed(2)}%</td>
          </tr>`
            )
            .join("")
        : '<tr><td colspan="5">暂无已填写标准结果的样本</td></tr>';
      $("#evalSummaryHint").textContent = `共 ${d.sample_total || 0} 个样本，整体平均字符准确率 ${(((d.overall_char_accuracy || 0) * 100).toFixed(2))}%`;
    } catch (e) {
      $("#evalSummaryBody").innerHTML = `<tr><td colspan="5">读取失败：${esc(e.message)}</td></tr>`;
    }
  }

  $("#btnEvalRun").addEventListener("click", runEvalCompare);
  $("#btnEvalReload").addEventListener("click", loadEvalRecords);
  $("#btnEvalSummary").addEventListener("click", loadEvalSummary);

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

  // 审核令牌（仅存本机浏览器，用于提交审核）
  $("#reviewTokenInput").value = store.reviewToken;
  $("#reviewTokenHint").textContent = store.reviewToken ? "已保存审核令牌（仅本机）" : "尚未配置审核令牌：审核台的通过/拒绝会提交失败。";
  $("#btnSaveReviewToken").addEventListener("click", () => {
    store.reviewToken = $("#reviewTokenInput").value.trim();
    localStorage.setItem(REVIEW_TOKEN_KEY, store.reviewToken);
    $("#reviewTokenHint").textContent = store.reviewToken ? "已保存审核令牌（仅本机）" : "已清除审核令牌。";
    updateReviewTokenState();
    showToast("审核令牌已保存", "success");
  });

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
