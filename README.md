# OCR 识别系统 · 前端（ocr-web）

一体化智慧储运分拣系统 **前端层** 的独立网页项目。纯静态（HTML/CSS/JS），可直接部署到 **GitHub Pages**。

> 系统架构见 `assets/architecture.png`（来源：分工.pdf）。
> 前端职责：UI 组件、状态管理、路由、API 调用、请求/响应处理。

## 目录结构

```
ocr-web/
├── index.html          # 主页面（单页应用，Tab 路由）
├── css/style.css       # 样式（现代简约、响应式）
├── js/app.js           # 前端逻辑（路由 / 状态管理 / API 调用）
├── assets/
│   └── architecture.png # 系统架构图
├── api_server.py       # （可选）本地 OCR 后端 API，让前端真正对接 OCR
└── README.md           # 本说明
```

## 功能

- **图片识别**：上传图片 → 调用后端（Unlimited-OCR）识别 → 展示文本 / 复制 / 下载 / 历史记录
- **视频识别**：上传视频 + 设置时段 → 调用后端（PaddleOCR）抽帧识别 → 表格展示
- **系统架构**：展示分工.pdf 中的整体架构图与分层说明
- **关于**：配置后端 API 地址、连接测试
- 未配置后端时以**演示模式**运行（内置示例数据），GitHub Pages 可直接预览

## 一、GitHub Pages 静态部署

### 方式 A：整个 ocr-web 作为站点（推荐）

1. 在 GitHub 新建仓库（如 `ocr-web`），把 `ocr-web/` 下的文件推到仓库根目录：

   ```bash
   cd ocr-web
   git init
   git add .
   git commit -m "OCR 识别系统前端 v1"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/ocr-web.git
   git push -u origin main
   ```

2. 打开仓库 → **Settings** → **Pages**
   - Source 选 `Deploy from a branch`
   - Branch 选 `main`，目录 `/ (root)`
   - Save

3. 等待 1~2 分钟，即可访问：
   `https://<你的用户名>.github.io/ocr-web/`

### 方式 B：以用户名仓库作为主页

若你的仓库名为 `<用户名>.github.io`，把文件推到 main 后，访问 `https://<用户名>.github.io/` 即可。

## 二、对接真实 OCR（本地运行）

静态页无法运行模型；要"直接识别"，在本机启动 API 服务（需已装 venv_uno）：

```bash
# 在项目根目录（Unlimited-OCR-main）下
venv_uno\Scripts\python.exe ocr-web\api_server.py --port 8000
```

然后在前端「关于」页配置 API 地址：`http://127.0.0.1:8000`，点「保存」+「测试连接」。

> 说明：图片识别首次需加载 Unlimited-OCR（GPU，数分钟）；视频识别用 PaddleOCR（CPU）。
> 若前端部署在 GitHub Pages（https），浏览器跨域访问本地 http 需允许混合内容；本地打开 index.html 无此问题。

## 三、本地预览

直接双击 `ocr-web/index.html`，或用任意静态服务器：

```bash
cd ocr-web
python -m http.server 8080
# 浏览器打开 http://127.0.0.1:8080
```

---

**版本**：与系统同步 v3.2 · **分工**：前端层（UI / 状态 / 路由 / API）
