import cgi
import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen


HOST = "127.0.0.1"
PORT = int(os.environ.get("MOM_BRIDGE_PORT", "9001"))
AZURE_SPEECH_KEY = os.environ.get("AZURE_SPEECH_KEY") or os.environ.get("AZURE_KEY") or os.environ.get("MAI_KEY") or ""
AZURE_SPEECH_REGION = os.environ.get("AZURE_SPEECH_REGION") or os.environ.get("AZURE_REGION") or os.environ.get("MAI_REGION") or "eastus"
AZURE_SPEECH_ENDPOINT = (os.environ.get("AZURE_SPEECH_ENDPOINT") or "").rstrip("/")
AZURE_OPENAI_KEY = os.environ.get("AZURE_OPENAI_KEY") or os.environ.get("OAI_KEY") or ""
AZURE_OPENAI_ENDPOINT = os.environ.get("AZURE_OPENAI_ENDPOINT") or os.environ.get("OAI_ENDPOINT") or "https://ttsdeploy.openai.azure.com/"
AZURE_OPENAI_DEPLOYMENT = os.environ.get("AZURE_OPENAI_DEPLOYMENT") or os.environ.get("OAI_DEPLOY") or "gpt-4o"
AZURE_OPENAI_API_VERSION = os.environ.get("AZURE_OPENAI_API_VERSION") or os.environ.get("OAI_API_VERSION") or "2025-01-01-preview"

WORKDIR = os.path.join(tempfile.gettempdir(), "betime-mom-bridge")
UPLOAD_DIR = os.path.join(WORKDIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)


def cors_headers(handler):
    origin = handler.headers.get("Origin") or "*"
    handler.send_header("Access-Control-Allow-Origin", origin)
    handler.send_header("Access-Control-Allow-Credentials", "true")
    handler.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, X-Frappe-CSRF-Token, Authorization")
    handler.send_header("Access-Control-Expose-Headers", "Content-Type")


def read_json(handler):
    length = int(handler.headers.get("Content-Length") or 0)
    raw = handler.rfile.read(length) if length else b""
    if not raw:
        return {}
    try:
      return json.loads(raw.decode("utf-8"))
    except Exception:
      return {}


def json_response(handler, payload, status=200):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    cors_headers(handler)
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def text_response(handler, text, status=200, content_type="text/plain; charset=utf-8"):
    body = text.encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    cors_headers(handler)
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def save_upload(handler):
    env = {
        "REQUEST_METHOD": "POST",
        "CONTENT_TYPE": handler.headers.get("Content-Type", ""),
        "CONTENT_LENGTH": handler.headers.get("Content-Length", "0"),
    }
    form = cgi.FieldStorage(fp=handler.rfile, headers=handler.headers, environ=env, keep_blank_values=True)
    file_item = form["file"] if "file" in form else None
    if not file_item or not getattr(file_item, "file", None):
        return None

    original_name = getattr(file_item, "filename", None) or "upload.wav"
    safe_name = os.path.basename(original_name).replace("..", "_")
    file_id = f"stt_{threading.get_ident()}_{os.urandom(4).hex()}"
    out_name = f"{file_id}_{safe_name}"
    out_path = os.path.join(UPLOAD_DIR, out_name)
    with open(out_path, "wb") as f:
        f.write(file_item.file.read())
    return {
        "id": file_id,
        "file_url": f"/stt-files/{out_name}",
        "name": file_id,
        "original_name": safe_name,
        "path": out_path,
    }


def wav_duration_seconds(wav_path):
    import wave
    with wave.open(wav_path, "rb") as wf:
        frames = wf.getnframes()
        rate = wf.getframerate()
        if not rate:
            return 0
        return frames / float(rate)


def azure_speech_transcribe(wav_path):
    duration = wav_duration_seconds(wav_path)
    if duration <= 60:
        return azure_speech_rest_short(wav_path)
    return azure_speech_rest_short(wav_path)


def azure_speech_rest_short(wav_path):
    base = AZURE_SPEECH_ENDPOINT or f"https://{AZURE_SPEECH_REGION}.stt.speech.microsoft.com"
    url = f"{base}/speech/recognition/conversation/cognitiveservices/v1?language=th-TH&format=simple"
    with open(wav_path, "rb") as fh:
        req = Request(
            url,
            data=fh.read(),
            method="POST",
            headers={
                "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
                "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
                "Accept": "application/json",
            },
        )
    with urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    text = (data.get("DisplayText") or "").strip()
    return text


def azure_openai_chat(messages, max_tokens=1200, temperature=0.2):
    url = f"{AZURE_OPENAI_ENDPOINT.rstrip('/')}/openai/deployments/{AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version={AZURE_OPENAI_API_VERSION}"
    body = json.dumps({
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }).encode("utf-8")
    req = Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "api-key": AZURE_OPENAI_KEY,
        },
    )
    with urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"]


def analyse_transcript(transcript, meeting_title="", project="", meeting_date=""):
    prompt = f"""
You are a senior Project Manager. Summarize the meeting transcript into JSON only.
Return these keys:
- summary: array of concise but detailed bullet strings
- decisions: array of decision strings
- risks: array of risk strings
- issues: array of issue strings
- dates: array of objects with date_range, month_hint, context
- tasks: array of objects with task_name, owner, deadline, priority, dependency

Rules:
- Be detailed and practical from a PM/leader perspective.
- Use plain, professional language.
- If date is unclear, use a range like "12-15" and month_hint if available.
- Do not invent facts. If not clear, use "ยังไม่ชัดเจน".

Meeting title: {meeting_title}
Project: {project}
Date: {meeting_date}
Transcript:
{transcript}
""".strip()
    content = azure_openai_chat([
        {"role": "system", "content": "Return only valid JSON."},
        {"role": "user", "content": prompt},
    ], max_tokens=2000, temperature=0.2)
    try:
        data = json.loads(content)
    except Exception:
        start = content.find("{")
        end = content.rfind("}")
        data = json.loads(content[start:end + 1]) if start != -1 and end != -1 else {}
    return {
        "summary": data.get("summary") or [],
        "decisions": data.get("decisions") or [],
        "risks": data.get("risks") or [],
        "issues": data.get("issues") or [],
        "dates": data.get("dates") or [],
        "tasks": data.get("tasks") or [],
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def do_OPTIONS(self):
        self.send_response(204)
        cors_headers(self)
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            return json_response(self, {
                "ok": True,
                "service": "mom-bridge",
                "azure_speech": bool(AZURE_SPEECH_KEY and (AZURE_SPEECH_ENDPOINT or AZURE_SPEECH_REGION)),
                "azure_openai": bool(AZURE_OPENAI_KEY and AZURE_OPENAI_ENDPOINT),
            })
        if path.startswith("/stt-files/"):
            file_name = os.path.basename(path)
            file_path = os.path.join(UPLOAD_DIR, file_name)
            if not os.path.exists(file_path):
                return text_response(self, "Not found", 404)
            with open(file_path, "rb") as fh:
                body = fh.read()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            cors_headers(self)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return text_response(self, "Not found", 404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/method/upload_file":
            try:
                upload = save_upload(self)
                if not upload:
                    return json_response(self, {"message": {"error": "file is required"}}, 400)
                return json_response(self, {
                    "message": {
                        "file_url": upload["file_url"],
                        "name": upload["name"],
                        "original_name": upload["original_name"],
                    }
                })
            except Exception as exc:
                return json_response(self, {"exc": str(exc)}, 500)

        if path == "/api/method/betime_solution.api.portal.process_audio_stt":
            try:
                if self.headers.get("Content-Type", "").startswith("application/x-www-form-urlencoded"):
                    length = int(self.headers.get("Content-Length") or 0)
                    raw = self.rfile.read(length).decode("utf-8") if length else ""
                    form = parse_qs(raw)
                    file_path = (form.get("file_path") or [""])[0]
                    meeting_title = (form.get("meeting_title") or [""])[0]
                    meeting_date = (form.get("meeting_date") or [""])[0]
                    project = (form.get("project") or [""])[0]
                else:
                    payload = read_json(self)
                    file_path = payload.get("file_path", "")
                    meeting_title = payload.get("meeting_title", "")
                    meeting_date = payload.get("meeting_date", "")
                    project = payload.get("project", "")

                if not file_path:
                    return json_response(self, {"message": "file_path is required"}, 400)
                file_name = os.path.basename(file_path)
                wav_path = os.path.join(UPLOAD_DIR, file_name)
                if not os.path.exists(wav_path):
                    return json_response(self, {"message": f"file not found: {file_path}"}, 404)

                transcript = azure_speech_transcribe(wav_path)
                analysis = analyse_transcript(transcript, meeting_title, project, meeting_date)
                analysis["transcript"] = transcript
                return json_response(self, {"message": analysis})
            except Exception as exc:
                return json_response(self, {"exc": str(exc)}, 500)

        if path == "/api/method/betime_solution.api.portal.save_mom_from_stt":
            try:
                if self.headers.get("Content-Type", "").startswith("application/x-www-form-urlencoded"):
                    length = int(self.headers.get("Content-Length") or 0)
                    raw = self.rfile.read(length).decode("utf-8") if length else ""
                    form = parse_qs(raw)
                    meeting_title = (form.get("meeting_title") or [""])[0]
                    meeting_date = (form.get("meeting_date") or [""])[0]
                    project = (form.get("project") or [""])[0]
                else:
                    payload = read_json(self)
                    meeting_title = payload.get("meeting_title", "")
                    meeting_date = payload.get("meeting_date", "")
                    project = payload.get("project", "")
                return json_response(self, {
                    "message": {
                        "mom_name": f"MOM-{threading.get_ident()}",
                        "meeting_title": meeting_title,
                        "meeting_date": meeting_date,
                        "project": project,
                    }
                })
            except Exception as exc:
                return json_response(self, {"exc": str(exc)}, 500)

        return text_response(self, "Not found", 404)


def main():
    if not AZURE_SPEECH_KEY:
        print("WARNING: Azure Speech key not configured")
    if not AZURE_OPENAI_KEY:
        print("WARNING: Azure OpenAI key not configured")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Mom bridge listening on http://{HOST}:{PORT}")
    print(f"Workdir: {WORKDIR}")
    server.serve_forever()


if __name__ == "__main__":
    main()
