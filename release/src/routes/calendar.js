/**
 * routes/calendar.js
 * GET/POST /calendar, CRUD /meeting-moms, POST /meeting-mom/process
 */

import { pgQuery, pgFirst } from '../db.js';
import { json, err, uid } from '../utils.js';
import { requireAuth } from '../middleware/auth.js';

// ── Azure Speech helpers ────────────────────────────────────────────

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const clean = String(base64 || '').replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function stripCodeFences(text) {
  return String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function resolveAzureChatConfig(env) {
  const explicitUrl = String(
    env.AZURE_AI_URL ||
    env.AZURE_AI_MODELS_CHAT_URL ||
    env.AZURE_OPENAI_CHAT_URL ||
    ''
  ).trim();
  const endpoint = String(
    env.AZURE_AI_ENDPOINT ||
    env.AZURE_AI_MODELS_CHAT_ENDPOINT ||
    env.AZURE_OPENAI_ENDPOINT ||
    env.OAI_ENDPOINT ||
    ''
  ).trim();
  const azureKey = String(
    env.AZURE_AI_KEY ||
    env.AZURE_AI_MODELS_CHAT_KEY ||
    env.AZURE_OPENAI_API_KEY ||
    env.AZURE_OPENAI_KEY ||
    env.OAI_KEY ||
    ''
  ).trim();
  const modelName = String(
    env.AZURE_AI_MODEL ||
    env.AZURE_AI_MODELS_CHAT_MODEL ||
    env.AZURE_OPENAI_MODEL ||
    'gpt-4o'
  ).trim();
  const deployment = String(
    env.AZURE_AI_DEPLOYMENT ||
    env.AZURE_AI_MODELS_CHAT_DEPLOYMENT ||
    env.AZURE_OPENAI_DEPLOYMENT ||
    env.OAI_DEPLOY ||
    modelName
  ).trim();
  const apiVersion = String(
    env.AZURE_AI_API_VERSION ||
    env.AZURE_AI_MODELS_CHAT_API_VERSION ||
    env.AZURE_OPENAI_API_VERSION ||
    env.OAI_API_VERSION ||
    '2024-12-01-preview'
  ).trim();
  const azureUrl = explicitUrl || (
    endpoint && deployment
      ? `${endpoint.replace(/\/+$/, '')}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`
      : ''
  );
  if (!azureUrl || !azureKey) {
    throw new Error('Azure AI is not configured');
  }
  return {
    azureUrl,
    azureKey,
    modelName,
    isDeploymentUrl: azureUrl.includes('/openai/deployments/'),
  };
}

function parseWavInfo(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readString = (offset, length) => String.fromCharCode(...bytes.slice(offset, offset + length));
  if (readString(0, 4) !== 'RIFF' || readString(8, 4) !== 'WAVE') return null;

  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= bytes.length) {
    const chunkId = readString(offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;
    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: view.getUint16(chunkDataOffset + 0, true),
        channels: view.getUint16(chunkDataOffset + 2, true),
        sampleRate: view.getUint32(chunkDataOffset + 4, true),
        byteRate: view.getUint32(chunkDataOffset + 8, true),
        blockAlign: view.getUint16(chunkDataOffset + 12, true),
        bitsPerSample: view.getUint16(chunkDataOffset + 14, true),
      };
    } else if (chunkId === 'data') {
      dataOffset = chunkDataOffset;
      dataLength = chunkSize;
      break;
    }
    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!fmt || dataOffset < 0) return null;
  return { ...fmt, dataOffset, dataLength };
}

function splitWavIntoChunks(bytes, maxSeconds = 50) {
  const info = parseWavInfo(bytes);
  if (!info || info.audioFormat !== 1 || info.bitsPerSample !== 16 || info.channels !== 1) {
    return [bytes];
  }

  const bytesPerSecond = info.sampleRate * info.channels * (info.bitsPerSample / 8);
  const maxDataBytes = Math.max(1, Math.floor(bytesPerSecond * maxSeconds));
  const header = bytes.slice(0, info.dataOffset);
  const chunks = [];
  for (let pos = 0; pos < info.dataLength; pos += maxDataBytes) {
    const dataSlice = bytes.slice(info.dataOffset + pos, info.dataOffset + Math.min(info.dataLength, pos + maxDataBytes));
    const wav = new Uint8Array(header.length + dataSlice.length);
    wav.set(header, 0);
    wav.set(dataSlice, header.length);
    const view = new DataView(wav.buffer);
    view.setUint32(4, wav.length - 8, true);
    view.setUint32(40, dataSlice.length, true);
    chunks.push(wav);
  }
  return chunks.length ? chunks : [bytes];
}

async function transcribeMomAudio(env, fileMeta) {
  const speechKey = String(env.AZURE_SPEECH_KEY || env.AZURE_KEY || env.MAI_KEY || '').trim();
  const speechEndpoint = String(env.AZURE_SPEECH_ENDPOINT || '').trim().replace(/\/$/, '');
  const speechRegion = String(env.AZURE_SPEECH_REGION || env.AZURE_REGION || env.MAI_REGION || '').trim();
  if (!speechKey || (!speechEndpoint && !speechRegion)) {
    throw new Error('Azure Speech is not configured');
  }

  const endpoint = speechEndpoint
    ? `${speechEndpoint}/speech/recognition/conversation/cognitiveservices/v1?language=th-TH`
    : `https://${speechRegion}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=th-TH`;
  const chunks = splitWavIntoChunks(fileMeta.bytes, 50);
  const transcripts = [];

  for (const chunk of chunks) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': speechKey,
        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
      },
      body: chunk,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Azure Speech error (${res.status}): ${text.slice(0, 300)}`);
    }

    let payload = {};
    try {
      payload = JSON.parse(text);
    } catch {
      payload = {};
    }

    const part = String(payload.DisplayText || payload.displayText || payload.NBest?.[0]?.Display || payload.NBest?.[0]?.DisplayText || '').trim();
    if (part) transcripts.push(part);
  }

  return transcripts.join('\n').trim();
}

async function analyseMomTranscript(env, transcript, meetingTitle = '', project = '', meetingDate = '') {
  const { azureUrl, azureKey, modelName, isDeploymentUrl } = resolveAzureChatConfig(env);
  const unclearText = 'ยังไม่ชัดเจน';
  const systemPrompt = [
    'You are a senior Project Manager / Team Lead writing Minutes of Meeting.',
    'Answer every user-visible value in Thai, using a practical PM/leader point of view.',
    'Return valid JSON only with this exact shape:',
    '{',
    '  "summary": ["..."],',
    '  "decisions": ["..."],',
    '  "risks": ["..."],',
    '  "issues": ["..."],',
    '  "dates": [{"date_range":"12-15","month_hint":"May","context":"..."}],',
    '  "tasks": [{"owner":"...","task":"...","deadline":"...","priority":"High","dependency":"..."}]',
    '}',
    'Rules:',
    `- If information is unclear or missing, use "${unclearText}".`,
    '- Extract owner, deadline, priority, and dependency when available.',
    '- For unclear dates, return an estimated range such as "12-15" and include month_hint if available.',
    '- Focus on what a PM must decide, track, or follow up.',
  ].join('\n');

  const userPrompt = [
    `Meeting title: ${meetingTitle || '-'}`,
    `Project: ${project || '-'}`,
    `Meeting date: ${meetingDate || '-'}`,
    '',
    'Transcript:',
    transcript || '',
  ].join('\n');

  const payload = {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: 1800,
    model: modelName,
  };
  if (isDeploymentUrl) delete payload.model;

  const res = await fetch(azureUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': azureKey,
      ...(!isDeploymentUrl && modelName ? { 'x-ms-model-mesh-model-name': modelName } : {}),
    },
    body: JSON.stringify(payload),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Azure AI error (${res.status}): ${raw.slice(0, 300)}`);
  }

  const jsonData = JSON.parse(raw);
  const content = stripCodeFences(jsonData?.choices?.[0]?.message?.content || '');
  if (!content) throw new Error('Empty AI response');

  try {
    return JSON.parse(content);
  } catch {
    return {
      summary: [content],
      decisions: [],
      risks: [],
      issues: [],
      dates: [],
      tasks: [],
    };
  }
}

async function fetchStoredFileByUrl(env, fileUrl) {
  const { ensureFilesSchema } = await import('./files.js');
  const raw = String(fileUrl || '').trim();
  if (!raw) return null;

  let r2Key = '';
  if (raw.startsWith('/api/files/')) r2Key = decodeURIComponent(raw.slice('/api/files/'.length));
  else if (raw.startsWith('/files/')) r2Key = decodeURIComponent(raw.slice('/files/'.length));
  else r2Key = raw;

  await ensureFilesSchema(env);
  const meta = await pgFirst(env, `SELECT * FROM files WHERE r2_key=$1 OR id=$1`, [r2Key]);
  if (!meta) return null;

  return {
    ...meta,
    bytes: base64ToBytes(meta.content_base64 || ''),
  };
}

export async function handleCalendar(path, method, request, env) {
  const url = new URL(request.url);

  /* ── CALENDAR ─────────────────────────────────────────── */
  if (path === '/calendar') {
    if (method === 'GET') { await requireAuth(request,env); const from=url.searchParams.get('from')||new Date().toISOString().slice(0,7)+'-01'; const to=url.searchParams.get('to')||new Date(new Date().setMonth(new Date().getMonth()+1)).toISOString().slice(0,10); const r=await pgQuery(env,`SELECT * FROM calendar_events WHERE start_datetime>=$1 AND start_datetime<=$2 ORDER BY start_datetime`,[from,to]); return json({ok:true,data:r}); }
    if (method === 'POST') { const s=await requireAuth(request,env); const b=await request.json(); const id='evt_'+uid().slice(0,8); await pgQuery(env,`INSERT INTO calendar_events (id,title,event_type,start_datetime,end_datetime,location,attendees,description,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,b.title,b.event_type||'Meeting',b.start_datetime,b.end_datetime||null,b.location||'',JSON.stringify(b.attendees||[]),b.description||'',s.user_id]); return json({ok:true,id}); }
  }

  /* ── MEETING MOM ──────────────────────────────────────── */
  if (path === '/meeting-moms') {
    if (method === 'GET') { await requireAuth(request,env); const r=await pgQuery(env,`SELECT m.*,u.full_name author_name FROM meeting_moms m LEFT JOIN users u ON m.created_by=u.id ORDER BY m.meeting_date DESC LIMIT 20`); return json({ok:true,data:r}); }
    if (method === 'POST') { const s=await requireAuth(request,env); const b=await request.json(); const id='mom_'+uid().slice(0,8); await pgQuery(env,`INSERT INTO meeting_moms (id,project,meeting_date,attendees,agenda,decisions,action_items,ai_summary,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,b.project||'',b.meeting_date||new Date().toISOString().slice(0,10),JSON.stringify(b.attendees||[]),b.agenda||'',b.decisions||'',JSON.stringify(b.action_items||[]),b.ai_summary||'',s.user_id]); return json({ok:true,id}); }
  }
  if (path.startsWith('/meeting-moms/')) {
    const id=path.split('/')[2];
    if (method === 'PUT') { await requireAuth(request,env); const b=await request.json(); await pgQuery(env,`UPDATE meeting_moms SET project=$1,meeting_date=$2,attendees=$3,agenda=$4,decisions=$5,action_items=$6,ai_summary=$7 WHERE id=$8`,[b.project,b.meeting_date,JSON.stringify(b.attendees||[]),b.agenda,b.decisions,JSON.stringify(b.action_items||[]),b.ai_summary||'',id]); return json({ok:true}); }
    if (method === 'DELETE') { await requireAuth(request,env); await pgQuery(env,`DELETE FROM meeting_moms WHERE id=$1`,[id]); return json({ok:true}); }
  }

  if (path === '/meeting-mom/process' && method === 'POST') {
    const s = await requireAuth(request, env);
    const b = await request.json();
    const fileUrl = String(b.file_path || b.file_url || '').trim();
    if (!fileUrl) return err('file_path is required', 400);

    const fileMeta = await fetchStoredFileByUrl(env, fileUrl);
    if (!fileMeta) return err('File not found', 404);

    const transcript = await transcribeMomAudio(env, fileMeta);
    const analysis = await analyseMomTranscript(
      env,
      transcript,
      String(b.meeting_title || '').trim(),
      String(b.project || '').trim(),
      String(b.meeting_date || '').trim(),
    );

    return json({
      ok: true,
      transcript,
      summary: Array.isArray(analysis.summary) ? analysis.summary : [String(analysis.summary || '').trim()].filter(Boolean),
      decisions: Array.isArray(analysis.decisions) ? analysis.decisions : [],
      risks: Array.isArray(analysis.risks) ? analysis.risks : [],
      issues: Array.isArray(analysis.issues) ? analysis.issues : [],
      dates: Array.isArray(analysis.dates) ? analysis.dates : [],
      tasks: Array.isArray(analysis.tasks) ? analysis.tasks : [],
      analyzed_by: s.user_id,
    });
  }

  return null;
}
