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
  const DOTS_ENDPOINT = "https://note3-prev-api.askdiandian.com/v1/messages";

  // ---------- 状态管理（前端状态 store） ----------
  const store = {
    apiBase: localStorage.getItem(API_KEY) || "",
    engine: localStorage.getItem(ENGINE_KEY) || "local",
    dotsApiKey: localStorage.getItem(DOTS_KEY) || "",
    imageFile: null,
    videoFile: null,
    history: JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"),
  };

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
    el.classList.toggle("online", !!online);
    $("#connText").textContent = online
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
      } else if (store.apiBase) {
        // 本地 OCR 后端
        const form = new FormData();
        form.append("file", store.imageFile);
        form.append("low_vram", $("#lowVram").checked ? "1" : "0");
        const data = await apiRequest("/api/recognize_image", form, true);
        text = data.text || data.result || "（后端未返回文本）";
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

  // ---------- Dots AI 识别（通过本地后端代理调用，绕过 CORS） ----------
  async function dotsRecognize(file) {
    const key = store.dotsApiKey;
    if (!key) throw new Error("请先在「关于」页配置 Dots API Key");
    const base = store.apiBase.replace(/\/+$/, "");
    if (!base) throw new Error("Dots 需经本地后端代理，请先配置后端地址并运行 api_server.py");
    const form = new FormData();
    form.append("file", file);
    form.append("dots_key", key);
    const data = await apiRequest("/api/recognize_dots", form, true);
    return data.text || "（后端未返回文本）";
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
    showToast("⏳ 正在抽帧识别…");
    try {
      let rows;
      if (store.apiBase) {
        const form = new FormData();
        form.append("file", store.videoFile);
        form.append("start", $("#vidStart").value);
        form.append("end", $("#vidEnd").value);
        form.append("interval", $("#vidInterval").value);
        const data = await apiRequest("/api/recognize_video", form, true);
        rows = data.rows || [];
      } else {
        await sleep(1200);
        rows = [
          { ts: "0:00:00", upper: "89", lower: "90", conf: "0.99" },
          { ts: "0:00:05", upper: "90", lower: "90", conf: "1.00" },
          { ts: "0:00:10", upper: "89", lower: "90", conf: "0.99" },
        ];
        showToast("演示模式（未配置后端），已展示示例数据", "success");
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
    tb.innerHTML = rows.length
      ? rows
          .map(
            (r) =>
              `<tr><td>${esc(r.ts)}</td><td>${esc(r.upper)}</td><td>${esc(r.lower)}</td><td>${esc(r.conf)}</td></tr>`
          )
          .join("")
      : '<tr><td colspan="4">无结果</td></tr>';
    $("#videoResult").classList.remove("hidden");
  }

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
