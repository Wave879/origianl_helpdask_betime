"""
Azure AI integration layer.
All Azure service calls go through this module.
"""

import os
import frappe


ENV_ALIASES = {
    "azure_openai_endpoint": ("AZURE_OPENAI_ENDPOINT", "OAI_ENDPOINT"),
    "azure_openai_key": ("AZURE_OPENAI_API_KEY", "AZURE_OPENAI_KEY", "OAI_KEY"),
    "azure_openai_api_version": ("AZURE_OPENAI_API_VERSION", "OAI_API_VERSION"),
    "azure_openai_deployment": ("AZURE_OPENAI_DEPLOYMENT", "OAI_DEPLOY"),
    "azure_ai_models_chat_url": ("AZURE_AI_MODELS_CHAT_URL",),
    "azure_ai_models_chat_key": ("AZURE_AI_MODELS_CHAT_KEY",),
    "azure_ai_models_chat_model": ("AZURE_AI_MODELS_CHAT_MODEL",),
    "azure_openai_embedding_deployment": ("AZURE_OPENAI_EMBEDDING_DEPLOYMENT",),
    "azure_speech_key": ("AZURE_SPEECH_KEY", "AZURE_KEY"),
    "azure_speech_region": ("AZURE_SPEECH_REGION", "AZURE_REGION"),
    "azure_doc_intelligence_endpoint": (
        "AZURE_DOC_INTELLIGENCE_ENDPOINT",
        "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT",
        "DOCUMENT_INTELL_ENDPOINT",
        "Document_intell_endpoint",
    ),
    "azure_doc_intelligence_key": (
        "AZURE_DOC_INTELLIGENCE_KEY",
        "AZURE_DOCUMENT_INTELLIGENCE_KEY",
        "DOCUMENT_INTELL_KEY",
        "Document_intell_key",
    ),
    "azure_search_endpoint": ("AZURE_SEARCH_ENDPOINT",),
    "azure_search_key": ("AZURE_SEARCH_KEY",),
    "azure_search_index": ("AZURE_SEARCH_INDEX",),
}


def _get_setting(key: str, default: str = None) -> str:
    """Read config from Frappe site config, then environment variables."""
    val = frappe.conf.get(key) or os.getenv(key.upper())
    if not val:
        for env_name in ENV_ALIASES.get(key, ()):
            val = os.getenv(env_name)
            if val:
                break
    if not val and default is not None:
        return default
    if not val:
        aliases = ", ".join(ENV_ALIASES.get(key, ()))
        suffix = f" or env var ({aliases})" if aliases else ""
        frappe.throw(f"Missing Azure config key: {key}{suffix}.")
    return val


def _get_optional_setting(key: str, default: str = None) -> str:
    """Read config if present, otherwise return default without raising."""
    val = frappe.conf.get(key) or os.getenv(key.upper())
    if not val:
        for env_name in ENV_ALIASES.get(key, ()): 
            val = os.getenv(env_name)
            if val:
                break
    return val or default


def _get_bool_setting(key: str, default: bool = False) -> bool:
    raw = _get_optional_setting(key)
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "y", "on"}


# ---------------------------------------------------------------------------
# Azure OpenAI
# ---------------------------------------------------------------------------

def get_openai_client():
    """Return an Azure OpenAI client using site config credentials."""
    from openai import AzureOpenAI
    return AzureOpenAI(
        azure_endpoint=_get_setting("azure_openai_endpoint"),
        api_key=_get_setting("azure_openai_key"),
        api_version=_get_setting("azure_openai_api_version", "2024-02-01"),
    )


def _chat_completion_via_models_api(messages: list, temperature: float, max_tokens: int) -> str:
    """Call Azure AI model inference endpoint using a direct chat completions URL."""
    import requests

    url = _get_setting("azure_ai_models_chat_url")
    api_key = _get_setting("azure_ai_models_chat_key")
    model = _get_optional_setting("azure_ai_models_chat_model")

    # Truncate message content to avoid 413 Payload Too Large
    safe_messages = _truncate_messages(messages, max_chars_per_message=6000)

    payload = {
        "messages": safe_messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if model:
        payload["model"] = model

    response = requests.post(
        url,
        headers={
            "Content-Type": "application/json",
            "api-key": api_key,
        },
        json=payload,
        timeout=60,
    )
    response.raise_for_status()
    data = response.json()
    return data["choices"][0]["message"]["content"]


def _truncate_messages(messages: list, max_chars_per_message: int = 6000) -> list:
    """Truncate each message's content to avoid 413 Payload Too Large."""
    result = []
    for msg in messages:
        if isinstance(msg, dict) and isinstance(msg.get("content"), str):
            content = msg["content"]
            if len(content) > max_chars_per_message:
                content = content[:max_chars_per_message] + "\n...[truncated]"
            result.append({**msg, "content": content})
        else:
            result.append(msg)
    return result


def chat_completion(messages: list = None, model: str = None, temperature: float = 0.3,
                    max_tokens: int = 4096, system_prompt: str = None,
                    user_prompt: str = None) -> str:
    """
    Call Azure OpenAI chat completion.
    Returns the assistant message content as a string.
    """
    if messages is None:
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        if user_prompt:
            messages.append({"role": "user", "content": user_prompt})

    if _get_optional_setting("azure_ai_models_chat_url") and _get_optional_setting("azure_ai_models_chat_key"):
        return _chat_completion_via_models_api(messages, temperature, max_tokens)

    client = get_openai_client()
    deployment = model or _get_setting("azure_openai_deployment")

    # Truncate messages to avoid 413 Payload Too Large
    safe_messages = _truncate_messages(messages, max_chars_per_message=6000)

    response = client.chat.completions.create(
        model=deployment,
        messages=safe_messages,
        temperature=temperature,
        max_tokens=max_tokens,
    )
    return response.choices[0].message.content


def get_embedding(text: str) -> list[float]:
    """
    Generate a text embedding using Azure OpenAI embedding model.
    Returns a float vector suitable for pgvector storage.
    """
    client = get_openai_client()
    deployment = _get_setting("azure_openai_embedding_deployment")
    response = client.embeddings.create(input=text, model=deployment)
    return response.data[0].embedding


# ---------------------------------------------------------------------------
# Azure Speech-to-Text
# ---------------------------------------------------------------------------

def transcribe_audio(audio_path: str) -> str:
    """
    Transcribe audio file using Azure Speech SDK.
    Returns the full transcript as a string.
    """
    last_error = None

    try:
        rest_text = _transcribe_with_azure_speech_rest(audio_path)
        if rest_text.strip():
            return rest_text.strip()
    except Exception as exc:
        last_error = exc

    try:
        sdk_text = _transcribe_with_azure_speech_sdk(audio_path)
        if sdk_text.strip():
            return sdk_text.strip()
    except Exception as exc:
        last_error = exc

    if last_error:
        raise last_error
    frappe.throw("ไม่สามารถถอดเสียงได้")


def _transcribe_with_azure_speech_sdk(audio_path: str) -> str:
    """Transcribe audio using the Azure Speech SDK websocket client."""
    import azure.cognitiveservices.speech as speechsdk

    speech_config = speechsdk.SpeechConfig(
        subscription=_get_setting("azure_speech_key"),
        region=_get_setting("azure_speech_region"),
    )
    speech_config.speech_recognition_language = "th-TH"

    audio_config = speechsdk.audio.AudioConfig(filename=audio_path)
    recognizer = speechsdk.SpeechRecognizer(
        speech_config=speech_config, audio_config=audio_config
    )

    results = []
    done = False

    def handle_result(evt):
        if evt.result.reason == speechsdk.ResultReason.RecognizedSpeech:
            results.append(evt.result.text)

    def stop_cb(evt):
        nonlocal done
        done = True

    recognizer.recognized.connect(handle_result)
    recognizer.session_stopped.connect(stop_cb)
    recognizer.canceled.connect(stop_cb)
    recognizer.start_continuous_recognition()

    import time
    while not done:
        time.sleep(0.5)

    recognizer.stop_continuous_recognition()
    return " ".join(results).strip()


def _transcribe_with_azure_speech_rest(audio_path: str) -> str:
    """
    Transcribe audio using Azure Speech REST short-audio endpoint.
    Used when websocket-based SDK connectivity fails.
    """
    import requests

    region = _get_setting("azure_speech_region")
    key = _get_setting("azure_speech_key")
    language = "th-TH"
    endpoint = f"https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1"

    chunks = _build_rest_chunks(audio_path, chunk_seconds=50)
    if not chunks:
        raise RuntimeError("ไม่สามารถเตรียมไฟล์เสียงสำหรับ REST ได้")

    texts = []
    for chunk_path in chunks:
        with open(chunk_path, "rb") as fh:
            resp = requests.post(
                endpoint,
                params={"language": language, "format": "simple"},
                headers={
                    "Ocp-Apim-Subscription-Key": key,
                    "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
                    "Accept": "application/json",
                },
                data=fh.read(),
                timeout=90,
            )
        resp.raise_for_status()
        data = resp.json()
        if not isinstance(data, dict):
            continue
        status = data.get("RecognitionStatus")
        text = (data.get("DisplayText") or "").strip()
        if status == "Success" and text:
            texts.append(text)
        elif status in {"NoMatch", "InitialSilenceTimeout", "BabbleTimeout"} and text:
            texts.append(text)
    return " ".join(texts).strip()


def _prepare_wav_16k_mono(audio_path: str) -> str:
    """
    Best-effort conversion for Speech REST short-audio.
    If the input is already 16kHz mono PCM WAV, reuse it; otherwise resample.
    """
    import tempfile
    import wave

    lower = audio_path.lower()
    if lower.endswith(".wav"):
        try:
            with wave.open(audio_path, "rb") as src:
                channels = src.getnchannels()
                rate = src.getframerate()
                width = src.getsampwidth()
                frames = src.readframes(src.getnframes())
            if channels == 1 and rate == 16000 and width == 2:
                return audio_path
            converted = _resample_pcm_wav(frames, channels, width, rate)
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
            tmp.close()
            with wave.open(tmp.name, "wb") as dst:
                dst.setnchannels(1)
                dst.setsampwidth(2)
                dst.setframerate(16000)
                dst.writeframes(converted)
            return tmp.name
        except Exception:
            return audio_path
    return audio_path


def _build_rest_chunks(audio_path: str, chunk_seconds: int = 50) -> list[str]:
    """
    Convert audio into one or more 16kHz mono WAV chunks for REST short-audio.
    Supports WAV/OGG directly via soundfile; other formats fall back to pydub if available.
    """
    import os
    import tempfile
    import wave
    import audioop
    import numpy as np

    path = audio_path.lower()
    if path.endswith(".wav") or path.endswith(".ogg"):
        try:
            import soundfile as sf

            data, rate = sf.read(audio_path, always_2d=True)
            if data is None or len(data) == 0:
                return []
            if data.dtype.kind == "f":
                data = np.clip(data, -1.0, 1.0)
                data = (data * 32767.0).astype(np.int16)
            elif data.dtype != np.int16:
                data = data.astype(np.int16)
            if data.shape[1] > 1:
                data = data.mean(axis=1).astype(np.int16)
            else:
                data = data[:, 0]
            total = len(data)
            chunk_size = max(1, int(rate * chunk_seconds))
            out_paths = []
            for start in range(0, total, chunk_size):
                segment = data[start:start + chunk_size]
                raw = segment.tobytes()
                if rate != 16000:
                    raw, _ = audioop.ratecv(raw, 2, 1, rate, 16000, None)
                tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
                tmp.close()
                with wave.open(tmp.name, "wb") as dst:
                    dst.setnchannels(1)
                    dst.setsampwidth(2)
                    dst.setframerate(16000)
                    dst.writeframes(raw)
                out_paths.append(tmp.name)
            return out_paths
        except Exception:
            return []

    # Best effort for other formats: try pydub if installed and decodable locally.
    try:
        from pydub import AudioSegment

        audio = AudioSegment.from_file(audio_path)
        audio = audio.set_channels(1).set_frame_rate(16000).set_sample_width(2)
        total_ms = len(audio)
        chunk_ms = max(1000, int(chunk_seconds * 1000))
        out_paths = []
        for start in range(0, total_ms, chunk_ms):
            segment = audio[start:start + chunk_ms]
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
            tmp.close()
            segment.export(tmp.name, format="wav")
            out_paths.append(tmp.name)
        return out_paths
    except Exception:
        return []


def _resample_pcm_wav(frames: bytes, channels: int, sample_width: int, rate: int) -> bytes:
    """Resample PCM WAV audio to 16kHz mono 16-bit PCM."""
    import audioop

    if channels > 1:
        frames = audioop.tomono(frames, sample_width, 1, 1)
    if rate != 16000:
        frames, _ = audioop.ratecv(frames, sample_width, 1, rate, 16000, None)
    if sample_width != 2:
        frames = audioop.lin2lin(frames, sample_width, 2)
    return frames


# ---------------------------------------------------------------------------
# Azure Document Intelligence (OCR)
# ---------------------------------------------------------------------------

def ocr_document(document_url: str) -> dict:
    """
    Run OCR on a document URL using Azure Document Intelligence.
    Returns extracted content and tables.
    """
    from azure.ai.formrecognizer import DocumentAnalysisClient
    from azure.core.credentials import AzureKeyCredential

    client = DocumentAnalysisClient(
        endpoint=_get_setting("azure_doc_intelligence_endpoint"),
        credential=AzureKeyCredential(_get_setting("azure_doc_intelligence_key")),
    )
    poller = client.begin_analyze_document_from_url("prebuilt-layout", document_url)
    result = poller.result()

    pages_text = []
    for page in result.pages:
        for line in page.lines:
            pages_text.append(line.content)

    return {
        "content": "\n".join(pages_text),
        "page_count": len(result.pages),
        "tables": len(result.tables),
    }


# ---------------------------------------------------------------------------
# Azure AI Search (RAG)
# ---------------------------------------------------------------------------

def search_knowledge(query: str, top: int = 5) -> list[dict]:
    """
    Hybrid semantic + vector search against Azure AI Search knowledge index.
    """
    from azure.search.documents import SearchClient
    from azure.core.credentials import AzureKeyCredential

    client = SearchClient(
        endpoint=_get_setting("azure_search_endpoint"),
        index_name=_get_setting("azure_search_index"),
        credential=AzureKeyCredential(_get_setting("azure_search_key")),
    )
    results = client.search(
        search_text=query,
        top=top,
        query_type="semantic",
        semantic_configuration_name="betime-semantic",
        select=["title", "content", "source_link", "category"],
    )
    return [{"title": r["title"], "content": r["content"],
             "source": r.get("source_link", ""), "category": r.get("category", "")}
            for r in results]


def index_knowledge_chunk(chunk_id: str, title: str, content: str,
                           category: str, source_link: str = "") -> None:
    """Upload a knowledge chunk to Azure AI Search index."""
    from azure.search.documents import SearchClient
    from azure.core.credentials import AzureKeyCredential

    client = SearchClient(
        endpoint=_get_setting("azure_search_endpoint"),
        index_name=_get_setting("azure_search_index"),
        credential=AzureKeyCredential(_get_setting("azure_search_key")),
    )
    embedding = get_embedding(content)
    client.upload_documents([{
        "id": chunk_id,
        "title": title,
        "content": content,
        "category": category,
        "source_link": source_link,
        "content_vector": embedding,
    }])
