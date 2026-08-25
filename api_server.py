# -*- coding: utf-8 -*-
"""OCR 识别系统 · 本地后端 API 服务（可选，前端对接用）

让 ocr-web 前端真正调用本地 OCR 能力（对应架构中"后端服务 + RESTful API"）。
运行：python api_server.py   （默认 http://127.0.0.1:8000，可 --port 指定）

接口：
  GET  /health                     → {"status":"ok","engine":"..."}
  POST /api/recognize_image        上传图片(multipart: file, low_vram) → {"text":"..."}
  POST /api/recognize_video        上传视频(multipart: file,start,end,interval) → {"rows":[{ts,upper,lower,conf}]}

说明：
  - 图片用 Unlimited-OCR（GPU，首次加载需数分钟）；视频用 PaddleOCR（CPU）
  - 复用 ocr_worker.py 的清洗/去重/抽帧逻辑，识别参数与系统一致（no_repeat=4）
  - 已开 CORS，GitHub Pages 前端可跨域调用本服务
"""
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

# 项目根目录（ocr-web 的上一级），用于 import ocr_worker 及相对路径
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)

IMG_OUT = "Unlimited_out"
TMP = os.path.join("video_out", "_api_tmp")
os.makedirs(IMG_OUT, exist_ok=True)
os.makedirs(TMP, exist_ok=True)

from ocr_worker import clean_ocr_text, dedup_repeats, extract_frame

_model = None
_model_lock = threading.Lock()
_paddle = None
_paddle_lock = threading.Lock()


def get_image_model():
    """加载 Unlimited-OCR（全局缓存，线程安全）。"""
    global _model
    with _model_lock:
        if _model is None:
            import torch
            from transformers import AutoModel, AutoTokenizer
            tok = AutoTokenizer.from_pretrained("baidu/Unlimited-OCR", trust_remote_code=True)
            if torch.cuda.is_available():
                m = AutoModel.from_pretrained(
                    "baidu/Unlimited-OCR", trust_remote_code=True,
                    use_safetensors=True, dtype=torch.bfloat16,
                    low_cpu_mem_usage=True).eval().cuda()
            else:
                m = AutoModel.from_pretrained(
                    "baidu/Unlimited-OCR", trust_remote_code=True,
                    use_safetensors=True, dtype=torch.float32).eval()
            _model = (m, tok)
        return _model


def recognize_image(path, low_vram=False):
    """识别单张图片，返回清洗后的文本。"""
    from contextlib import redirect_stdout, redirect_stderr
    import torch
    model, tok = get_image_model()
    buf = io.StringIO()
    try:
        torch.cuda.empty_cache()
        with torch.no_grad(), redirect_stdout(buf), redirect_stderr(buf):
            model.infer(tokenizer=tok, prompt="<image>document parsing.",
                        image_file=path, output_path=IMG_OUT,
                        base_size=1024, image_size=640, crop_mode=True,
                        max_length=8192, no_repeat_ngram_size=4, ngram_window=64)
        torch.cuda.empty_cache()
    except Exception as e:
        return f"识别异常：{e}"
    raw = buf.getvalue().strip() or "（模型未输出文本）"
    return dedup_repeats(clean_ocr_text(raw))


def get_paddle():
    global _paddle
    with _paddle_lock:
        if _paddle is None:
            from paddleocr import PaddleOCR
            _paddle = PaddleOCR(lang="en", use_doc_orientation_classify=False,
                                use_doc_unwarping=False, use_textline_orientation=False,
                                enable_mkldnn=False, device="cpu",
                                text_rec_score_thresh=0.1, text_det_box_thresh=0.1)
        return _paddle


def recognize_video(video_path, start, end, interval):
    """抽帧 + PaddleOCR 中央数字识别，返回行列表。"""
    from ocr_worker import paddle_center_digits, fmt_time
    ocr = get_paddle()
    rows = []
    t = start
    while t <= end + 1e-9:
        frame = extract_frame(video_path, t)
        if frame is not None:
            upper, uc, lower, lc, _ = paddle_center_digits(ocr, frame)
            rows.append({"ts": fmt_time(int(round(t))),
                         "upper": upper, "lower": lower,
                         "conf": (round(uc, 2) if uc else "") + "/" + (round(lc, 2) if lc else "")})
        t += interval
    return rows


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            self._json(200, {"status": "ok", "engine": "Unlimited-OCR + PaddleOCR"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        try:
            ctype = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in ctype:
                return self._json(400, {"error": "需要 multipart/form-data"})
            import cgi
            form = cgi.FieldStorage(
                fp=self.rfile, headers=self.headers,
                environ={"REQUEST_METHOD": "POST",
                         "CONTENT_TYPE": ctype})
            path = self.path.split("?")[0]

            if path == "/api/recognize_image":
                f = form["file"]
                low = form.getvalue("low_vram") == "1"
                tmp = os.path.join(TMP, "img_" + str(int(time.time() * 1000)) +
                                   os.path.splitext(f.filename or ".jpg")[1])
                with open(tmp, "wb") as w:
                    w.write(f.file.read())
                try:
                    text = recognize_image(tmp, low)
                    return self._json(200, {"text": text})
                finally:
                    try:
                        os.remove(tmp)
                    except OSError:
                        pass

            elif path == "/api/recognize_video":
                f = form["file"]
                tmp = os.path.join(TMP, "vid_" + str(int(time.time() * 1000)) + ".mp4")
                with open(tmp, "wb") as w:
                    w.write(f.file.read())
                try:
                    def parse_hms(s):
                        p = [int(x) for x in s.strip().split(":")]
                        return p[0] * 3600 + p[1] * 60 + p[2] if len(p) == 3 else p[0] * 60 + p[1]
                    start = parse_hms(form.getvalue("start", "0:00:00"))
                    end = parse_hms(form.getvalue("end", "0:00:05"))
                    iv = float(form.getvalue("interval", "5") or 5)
                    rows = recognize_video(tmp, start, end, iv)
                    return self._json(200, {"rows": rows})
                finally:
                    try:
                        os.remove(tmp)
                    except OSError:
                        pass
            else:
                return self._json(404, {"error": "not found"})
        except Exception as e:
            return self._json(500, {"error": str(e)})

    def log_message(self, *a):
        pass


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    print("=" * 50)
    print("  OCR 识别系统 · 本地后端 API")
    print(f"  地址：http://{args.host}:{args.port}")
    print("  前端「关于」页配置该地址即可对接。")
    print("=" * 50)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
