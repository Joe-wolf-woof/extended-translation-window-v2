/**
 * main.js ― 拡張翻訳 - CultureLens（MVP）
 * 入力: カメラ映像 + マイク音声（Web Speech API / 手入力フォールバック）
 * 処理: engine/translate-engine.js（Gemini マルチモーダル拡張翻訳）
 * 出力: 字幕 + Three.js 空間タグピン
 */
import * as THREE from 'three';
import { extendedTranslate, translateUtterance, getApiKey, setApiKey, MOCK_RESULT, MOCK_UTTERANCE } from './engine/translate-engine.js?v=20261118-2';

const $ = (id) => document.getElementById(id);
const video = $('camera');
let stream = null;

/* ---------- カメラ ---------- */
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    $('status-chip').textContent = 'カメラ起動中（背面）';
    $('btn-record').disabled = false;
    $('btn-translate').disabled = false;
    applyResultVisibility();
  } catch (e) {
    $('status-chip').textContent = 'カメラを起動できませんでした: ' + e.message;
  }
  updateCameraButton();
}

/* ---------- カメラ ON/OFF トグル ----------
   OFFにしても翻訳結果（字幕・タグカード・ギャップ／フック・見比べ）は
   そのまま読める。止めるのは映像と空間タグとトラッキングだけ。 */
function stopCamera() {
  if (recognition) { recognition.stop(); }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  video.srcObject = null;
  stopTracking(true);
  tagGroup.visible = false;
  $('btn-record').disabled = true;
  $('btn-translate').disabled = true;
  $('status-chip').textContent = 'カメラ停止中';
  updateCameraButton();
}
function toggleCamera() {
  if (stream) stopCamera();
  else startCamera();
}
function updateCameraButton() {
  // 表示は「押すとどうなるか」：カメラON中は「📷 OFF」、停止中は「📷 ON」
  $('btn-camera').textContent = stream ? '📷 OFF' : '📷 ON';
  $('btn-camera').classList.toggle('off', !stream);
}

function captureFrame() {
  const c = document.createElement('canvas');
  const scale = Math.min(1, 960 / (video.videoWidth || 960));
  c.width = (video.videoWidth || 960) * scale;
  c.height = (video.videoHeight || 720) * scale;
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  const dataUrl = c.toDataURL('image/jpeg', 0.72);
  return { mimeType: 'image/jpeg', data: dataUrl.split(',')[1], bytes: Math.floor(dataUrl.length * 0.75) };
}

/* ---------- 音声入力（語り手の声） ---------- */
let recognition = null;
function toggleRecord() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert('このブラウザは音声認識に未対応です。下のテキスト欄に手入力してください。'); return; }
  if (recognition) { recognition.stop(); return; }
  recognition = new SR();
  recognition.lang = 'ja-JP';
  recognition.interimResults = true;
  recognition.continuous = true;
  let base = $('transcript').value;
  recognition.onresult = (ev) => {
    let text = '';
    for (const r of ev.results) text += r[0].transcript;
    $('transcript').value = base + text;
  };
  recognition.onend = () => { recognition = null; $('btn-record').textContent = '🎙 語る（音声入力）'; };
  recognition.onerror = () => { recognition = null; };
  recognition.start();
  $('btn-record').textContent = '⏹ 停止';
}

/* ---------- Three.js 空間タグ ---------- */
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
const scene = new THREE.Scene();
const cam3d = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
cam3d.position.z = 5;
// ジャイロ追従用：カメラ位置（0,0,5）を支点にタグ全体を回すためのグループ
const gyroGroup = new THREE.Group();
gyroGroup.position.set(0, 0, 5);
scene.add(gyroGroup);
let tagGroup = new THREE.Group();
tagGroup.position.z = -5;
gyroGroup.add(tagGroup);
let placedTags = []; // 配置済みタグ（言語切替時にラベルを描き直すために保持）

function resizeGL() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  cam3d.aspect = w / h;
  cam3d.updateProjectionMatrix();
}
new ResizeObserver(resizeGL).observe(canvas);

function makeLabelTexture(title, idx) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(10,12,16,0.82)';
  g.beginPath(); g.roundRect(4, 14, 504, 100, 22); g.fill();
  g.fillStyle = '#d29922';
  g.beginPath(); g.arc(52, 64, 26, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#111'; g.font = 'bold 40px sans-serif'; g.textAlign = 'center';
  g.fillText(String(idx + 1), 52, 79);
  g.fillStyle = '#fff'; g.font = 'bold 30px sans-serif'; g.textAlign = 'left';
  const t = title.length > 22 ? title.slice(0, 22) + '…' : title;
  g.fillText(t, 92, 76);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function placeTags(tags) {
  stopTracking(false);
  gyroGroup.remove(tagGroup);
  tagGroup = new THREE.Group();
  tagGroup.position.z = -5;
  // 画面の横方向の可視範囲（ラベルのはみ出し防止に使う）
  const halfH = 5 * Math.tan(THREE.MathUtils.degToRad(cam3d.fov / 2));
  const halfW = halfH * cam3d.aspect;
  const placed = [];
  tags.forEach((tag, i) => {
    // AIが返した画像内座標(0〜1)を NDC 経由で空間にピン留めする（固定カメラ近似）
    const ax = (tag.x - 0.5) * 4.6;
    const ay = (0.5 - tag.y) * 3.4;
    const anchor = new THREE.Group();
    anchor.position.set(ax, ay, 0);

    // 実物の位置を示す小さなアンカードット（実物を覆わない）
    const halo = new THREE.Mesh(
      new THREE.CircleGeometry(0.085, 24),
      new THREE.MeshBasicMaterial({ color: 0xd29922, transparent: true, opacity: 0.35 })
    );
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.045, 24),
      new THREE.MeshBasicMaterial({ color: 0xd29922, transparent: true, opacity: 0.95 })
    );
    anchor.add(halo, dot);

    // ラベルはコンパクトにし、実物の上部に浮かせてリーダーラインで結ぶ
    // 横方向はラベル全体が画面内に収まるようずらし、ラインを斜めにしてアンカーと結ぶ
    const labelDy = Math.max(0.3, Math.min(0.52, 1.95 - ay));
    const labelX = THREE.MathUtils.clamp(ax, -(halfW - 0.85), halfW - 0.85) - ax;
    const floatGroup = new THREE.Group();
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(1.55, 0.39),
      new THREE.MeshBasicMaterial({ map: makeLabelTexture(tagTitle(tag), i), transparent: true })
    );
    label.position.set(labelX, labelDy, 0);
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0.07, 0),
      new THREE.Vector3(labelX, Math.max(0.09, labelDy - 0.21), 0),
    ]);
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xd29922, transparent: true, opacity: 0.8 }));
    floatGroup.add(line, label);
    floatGroup.userData.phase = i * 1.3;
    anchor.userData.floatGroup = floatGroup;
    anchor.add(floatGroup);

    tagGroup.add(anchor);
    placed.push({ anchor, label, line, labelX, lineTopY: Math.max(0.09, labelDy - 0.21), u: tag.x, v: tag.y, tag, idx: i });
  });
  gyroGroup.add(tagGroup);
  placedTags = placed;
  initTrackers(placed);
}

/* ---------- 視覚トラッキング（テンプレートマッチング） ----------
   撮影フレームから各タグ位置の画像パッチを切り出し、現在の映像の中で
   正規化相関（NCC）が最大の位置を定期的に探してアンカーを追従させる。
   回転だけでなく移動にも追従する。見失いが続くタグはいったん隠すが、
   低頻度の全画面スキャンで再検出を続け、見つけたら再表示する。
   処理負荷が高い状態が続いたら追従を止めて全ラベルを隠す（発熱・重さ対策）。 */
const TRACK_W = 192;          // 追跡用の作業解像度（横px）
const TRACK_INTERVAL = 100;   // 追跡間隔(ms)
const TRACK_ACCEPT = 0.55;    // これ未満の相関は「見失い」
const TRACK_REACQUIRE = 0.65; // 再検出のしきい値（誤って別物に復活しないよう通常より厳しめ）
const TRACK_LOST_LIMIT = 10;  // 見失いが続いたらそのタグを隠す（約1秒分）
const TRACK_SLOW_LIMIT = 70;  // 1tickの平均処理時間(ms)がこれを超え続けたら全停止
const trackCanvas = document.createElement('canvas');
const trackCtx = trackCanvas.getContext('2d', { willReadFrequently: true });
let captureGray = null; // 撮影時点のグレースケールフレーム {data,w,h}
let trackers = [];
let trackTimer = null;
let trackCostEma = 0;
let tickCount = 0;
let reacquireIdx = 0;
let allLostShown = false;

function grabGray() {
  if (!video.videoWidth) return null;
  const w = TRACK_W;
  const h = Math.max(1, Math.round(TRACK_W * video.videoHeight / video.videoWidth));
  if (trackCanvas.width !== w || trackCanvas.height !== h) { trackCanvas.width = w; trackCanvas.height = h; }
  trackCtx.drawImage(video, 0, 0, w, h);
  const px = trackCtx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    gray[j] = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
  }
  return { data: gray, w, h };
}

function makeTemplate(frame, u, v) {
  const cx = Math.round(u * frame.w), cy = Math.round(v * frame.h);
  const half = 15;
  const x0 = Math.max(0, cx - half), y0 = Math.max(0, cy - half);
  const x1 = Math.min(frame.w, cx + half), y1 = Math.min(frame.h, cy + half);
  const tw = x1 - x0, th = y1 - y0;
  if (tw < 12 || th < 12) return null;
  // テンプレートは2pxおきにサンプルして軽量化（統計はすべてこの点集合で一貫させる）
  const pts = [];
  let sum = 0, sum2 = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const val = frame.data[y * frame.w + x];
      pts.push({ dx: x - x0, dy: y - y0, v: val });
      sum += val; sum2 += val * val;
    }
  }
  const n = pts.length;
  const mean = sum / n;
  const varT = sum2 / n - mean * mean;
  if (varT < 4) return null; // ほぼ無地のパッチは追跡できない
  return { pts, n, mean, varT, tw, th, offX: cx - x0, offY: cy - y0 };
}

function nccAt(frame, tpl, x0, y0) {
  let sumI = 0, sumI2 = 0, cross = 0;
  const d = frame.data, w = frame.w;
  for (let k = 0; k < tpl.pts.length; k++) {
    const p = tpl.pts[k];
    const val = d[(y0 + p.dy) * w + (x0 + p.dx)];
    sumI += val; sumI2 += val * val; cross += val * p.v;
  }
  const n = tpl.n;
  const meanI = sumI / n;
  const varI = sumI2 / n - meanI * meanI;
  if (varI < 1) return -1;
  return (cross / n - meanI * tpl.mean) / Math.sqrt(varI * tpl.varT);
}

function searchTemplate(frame, tr, othersPx) {
  const tpl = tr.tpl;
  const cx = Math.round(tr.u * frame.w), cy = Math.round(tr.v * frame.h);
  const radius = tr.lost > 0 ? 42 : 24; // 見失い中は探索範囲を広げて復帰を狙う
  const baseX = cx - tpl.offX, baseY = cy - tpl.offY;
  // 他タグの現在位置に近い候補は割り引く（似た模様への吸着とラベルの入れ替わりを防ぐ）
  const scoreAt = (x, y) => {
    let s = nccAt(frame, tpl, x, y);
    const px = x + tpl.offX, py = y + tpl.offY;
    for (const o of othersPx) {
      if (Math.abs(px - o.x) < 12 && Math.abs(py - o.y) < 12) { s *= 0.8; break; }
    }
    return s;
  };
  let best = null;
  for (let y = baseY - radius; y <= baseY + radius; y += 2) {
    for (let x = baseX - radius; x <= baseX + radius; x += 2) {
      if (x < 0 || y < 0 || x + tpl.tw > frame.w || y + tpl.th > frame.h) continue;
      const s = scoreAt(x, y);
      if (!best || s > best.score) best = { score: s, x, y };
    }
  }
  if (best) { // 最良点の近傍を1px刻みで微調整
    const bx = best.x, by = best.y;
    for (let y = by - 1; y <= by + 1; y++) {
      for (let x = bx - 1; x <= bx + 1; x++) {
        if (x < 0 || y < 0 || x + tpl.tw > frame.w || y + tpl.th > frame.h) continue;
        const s = scoreAt(x, y);
        if (s > best.score) best = { score: s, x, y };
      }
    }
  }
  if (!best) return null;
  return { score: best.score, u: (best.x + tpl.offX) / frame.w, v: (best.y + tpl.offY) / frame.h, x: best.x, y: best.y };
}

// 一致度が高いときだけ、現在の見た目をテンプレートへ少しずつ反映し、
// 角度や明るさで見た目が徐々に変わっても追従が外れにくくする
function updateTemplate(frame, tr, x0, y0) {
  const tpl = tr.tpl, d = frame.data, w = frame.w;
  let sum = 0, sum2 = 0;
  for (const p of tpl.pts) {
    const cur = d[(y0 + p.dy) * w + (x0 + p.dx)];
    p.v = p.v * 0.9 + cur * 0.1;
    sum += p.v; sum2 += p.v * p.v;
  }
  tpl.mean = sum / tpl.n;
  tpl.varT = Math.max(1, sum2 / tpl.n - tpl.mean * tpl.mean);
}

// 再検出用：フレーム全体からテンプレートを探す（粗く走査→近傍を精密化）
function searchFullFrame(frame, tr) {
  const tpl = tr.tpl;
  const othersPx = trackers
    .filter((t) => t !== tr && t.state === 'active')
    .map((t) => ({ x: t.u * frame.w, y: t.v * frame.h }));
  const scoreAt = (x, y) => {
    let s = nccAt(frame, tpl, x, y);
    const px = x + tpl.offX, py = y + tpl.offY;
    for (const o of othersPx) {
      if (Math.abs(px - o.x) < 12 && Math.abs(py - o.y) < 12) { s *= 0.8; break; }
    }
    return s;
  };
  let best = null;
  for (let y = 0; y + tpl.th <= frame.h; y += 3) {
    for (let x = 0; x + tpl.tw <= frame.w; x += 3) {
      const s = scoreAt(x, y);
      if (!best || s > best.score) best = { score: s, x, y };
    }
  }
  if (!best) return null;
  const bx = best.x, by = best.y;
  for (let y = by - 2; y <= by + 2; y++) {
    for (let x = bx - 2; x <= bx + 2; x++) {
      if (x < 0 || y < 0 || x + tpl.tw > frame.w || y + tpl.th > frame.h) continue;
      const s = scoreAt(x, y);
      if (s > best.score) best = { score: s, x, y };
    }
  }
  return { score: best.score, u: (best.x + tpl.offX) / frame.w, v: (best.y + tpl.offY) / frame.h, x: best.x, y: best.y };
}

function applyAnchorPos(tr) {
  const ax = (tr.u - 0.5) * 4.6;
  const ay = (0.5 - tr.v) * 3.4;
  tr.anchor.position.set(ax, ay, 0);
  // ラベルの横はみ出し防止オフセットも追従に合わせて更新する
  const halfH = 5 * Math.tan(THREE.MathUtils.degToRad(cam3d.fov / 2));
  const halfW = halfH * cam3d.aspect;
  const labelX = THREE.MathUtils.clamp(ax, -(halfW - 0.85), halfW - 0.85) - ax;
  if (Math.abs(labelX - tr.labelX) > 0.02) {
    tr.labelX = labelX;
    tr.label.position.x = labelX;
    tr.line.geometry.setFromPoints([
      new THREE.Vector3(0, 0.07, 0),
      new THREE.Vector3(labelX, tr.lineTopY, 0),
    ]);
  }
}

function trackTick() {
  if (!stream || video.readyState < 2) return;
  tickCount++;
  const hasActive = trackers.some((t) => t.state === 'active');
  const lostList = trackers.filter((t) => t.state === 'lost');
  const scanTick = lostList.length > 0 && tickCount % 8 === 0; // 再検出スキャンは約0.8秒に1回だけ（負荷分散）
  if (!hasActive && !scanTick) return;
  const frame = grabGray();
  if (!frame) return;
  const t0 = performance.now();
  for (const tr of trackers) {
    if (tr.state !== 'active') continue;
    const othersPx = trackers
      .filter((t) => t !== tr && t.state === 'active')
      .map((t) => ({ x: t.u * frame.w, y: t.v * frame.h }));
    const hit = searchTemplate(frame, tr, othersPx);
    if (hit && hit.score >= TRACK_ACCEPT) {
      tr.lost = 0;
      // 適応型平滑化：大きく動いたときは強く追従し、小さなブレだけ抑える（遅れ対策）
      const jump = Math.hypot((hit.u - tr.u) * frame.w, (hit.v - tr.v) * frame.h);
      const alpha = Math.min(0.92, 0.45 + jump / 25);
      tr.u += (hit.u - tr.u) * alpha;
      tr.v += (hit.v - tr.v) * alpha;
      applyAnchorPos(tr);
      if (hit.score >= 0.75) updateTemplate(frame, tr, hit.x, hit.y);
    } else {
      tr.lost++;
      if (tr.lost >= TRACK_LOST_LIMIT) { tr.state = 'lost'; tr.anchor.visible = false; }
    }
  }
  // 再検出：隠れたタグを1つずつ全画面から探し、見つけたら再表示する
  if (scanTick) {
    const tr = lostList[reacquireIdx++ % lostList.length];
    if (tr && tr.state === 'lost') {
      const hit = searchFullFrame(frame, tr);
      if (hit && hit.score >= TRACK_REACQUIRE) {
        tr.state = 'active';
        tr.lost = 0;
        tr.u = hit.u;
        tr.v = hit.v;
        tr.anchor.visible = true;
        applyAnchorPos(tr);
        if (hit.score >= 0.75) updateTemplate(frame, tr, hit.x, hit.y);
        if (!trackers.some((t) => t.state === 'lost')) allLostShown = false;
        if ($('status-chip').textContent.includes('再検出中')) $('status-chip').textContent = '拡張翻訳を表示中';
      }
    }
  }
  const cost = performance.now() - t0;
  trackCostEma = trackCostEma ? trackCostEma * 0.8 + cost * 0.2 : cost;
  if (trackCostEma > TRACK_SLOW_LIMIT) { hideAllTags('負荷軽減のため、ラベルを非表示にしました'); return; }
  if (trackers.length && trackers.every((t) => t.state === 'lost') && !allLostShown) {
    allLostShown = true;
    $('status-chip').textContent = '対象を見失ったためラベルを非表示にしました（再検出中）';
  }
}

function hideAllTags(msg) {
  stopTracking(false);
  tagGroup.children.forEach((a) => { a.visible = false; });
  $('status-chip').textContent = msg;
}

function stopTracking(resetCost) {
  if (trackTimer) { clearInterval(trackTimer); trackTimer = null; }
  trackers = [];
  tickCount = 0;
  reacquireIdx = 0;
  allLostShown = false;
  if (resetCost) trackCostEma = 0;
}

function initTrackers(placed) {
  stopTracking(true);
  if (!captureGray || !stream) return;
  for (const p of placed) {
    const tpl = makeTemplate(captureGray, p.u, p.v);
    if (!tpl) continue;
    trackers.push({ ...p, tpl, lost: 0, state: 'active' });
  }
  if (trackers.length) trackTimer = setInterval(trackTick, TRACK_INTERVAL);
}

function animate(t) {
  requestAnimationFrame(animate);
  tagGroup.children.forEach((a) => {
    const f = a.userData.floatGroup;
    if (f) f.position.y = Math.sin(t / 900 + f.userData.phase) * 0.04;
  });
  renderer.render(scene, cam3d);
}
requestAnimationFrame(animate);
resizeGL();

/* ---------- 拡張翻訳の実行 ---------- */
async function runTranslate() {
  const useDemo = $('chk-demo').checked;
  const transcript = $('transcript').value.trim();
  $('btn-translate').disabled = true;
  $('status-chip').textContent = '拡張翻訳中…';
  let frame = { mimeType: 'image/jpeg', data: '', bytes: 0 };
  if (stream && !useDemo) frame = captureFrame();
  // 追跡用に、撮影時点の映像を作業解像度グレースケールで控える
  captureGray = stream && !useDemo ? grabGray() : null;

  try {
    const result = useDemo ? { ...MOCK_RESULT, source: 'demo' } : await extendedTranslate(frame, transcript);
    renderResult(result);
    $('status-chip').textContent = '拡張翻訳を表示中';
  } catch (e) {
    $('status-chip').textContent = 'エラー: ' + e.message;
  } finally {
    $('btn-translate').disabled = false;
  }
}

/* ---------- カメラ画面の翻訳結果 表示/非表示トグル（右上の👁） ---------- */
let resultVisible = true;
let hasResult = false;
function applyResultVisibility() {
  $('subtitle-bar').classList.toggle('hidden', !(resultVisible && hasResult));
  tagGroup.visible = resultVisible;
}
$('btn-toggle-result').onclick = () => {
  resultVisible = !resultVisible;
  $('btn-toggle-result').classList.toggle('off', !resultVisible);
  applyResultVisibility();
};

/* ---------- 表示言語（案A：トグルチップで一括切替） ----------
   結果は英語・日本語の両方を保持し、表示だけを切り替える。
   言語状態はアプリ全体で1つ（localStorage に保存）。 */
let resultLang = localStorage.getItem('etw_result_lang') || 'en';
let lastResult = null;
const pick = (en, ja) => (resultLang === 'ja' ? (ja || en || '') : (en || ''));
const tagTitle = (tag) => pick(tag.title, tag.title_ja);
const tagDesc = (tag) => pick(tag.description, tag.description_ja);
const tagWhy = (tag) => pick(tag.why_it_matters, tag.why_it_matters_ja);

function updateLangChip() {
  $('btn-lang').innerHTML = resultLang === 'en' ? '<b>EN</b> / あ' : 'EN / <b>あ</b>';
}
$('btn-lang').onclick = () => {
  resultLang = resultLang === 'en' ? 'ja' : 'en';
  localStorage.setItem('etw_result_lang', resultLang);
  updateLangChip();
  if (lastResult) { renderTexts(); refreshTagLabels(); }
};
updateLangChip();

// 空間タグのラベルだけを現在の言語で描き直す（配置とトラッキングは維持する）
function refreshTagLabels() {
  for (const p of placedTags) {
    const tex = makeLabelTexture(tagTitle(p.tag), p.idx);
    if (p.label.material.map) p.label.material.map.dispose();
    p.label.material.map = tex;
    p.label.material.needsUpdate = true;
  }
}

// 字幕・タグカード・ギャップ欄を、現在の言語で描き直す
function renderTexts() {
  const r = lastResult;
  if (!r) return;
  $('subtitle-original').textContent = pick(r.literal_translation, r.literal_translation_ja);
  $('subtitle-extended').textContent = pick(r.extended_translation, r.extended_translation_ja);
  const cards = $('tag-cards');
  cards.innerHTML = '';
  $('tags-empty').style.display = r.tags?.length ? 'none' : '';
  (r.tags || []).forEach((tag, i) => {
    const div = document.createElement('div');
    div.className = 'tag-card';
    div.innerHTML = `<h4>${i + 1}. ${escapeHtml(tagTitle(tag))}</h4><p>${escapeHtml(tagDesc(tag))}</p><p class="why">なぜ大切か: ${escapeHtml(tagWhy(tag) || '')}</p>`;
    cards.appendChild(div);
  });
  if (r.cultural_gap || r.curiosity_hook) {
    $('gap-box').classList.remove('hidden');
    $('gap-text').textContent = pick(r.cultural_gap, r.cultural_gap_ja);
    $('hook-text').textContent = pick(r.curiosity_hook, r.curiosity_hook_ja);
  }
}

function renderResult(r) {
  hasResult = true;
  lastResult = r;
  renderTexts();
  const speakText = pick(r.extended_translation, r.extended_translation_ja);
  if ($('chk-speak').checked && speakText) {
    const u = new SpeechSynthesisUtterance(speakText);
    u.lang = resultLang === 'ja' ? 'ja-JP' : 'en-US'; u.rate = 0.98;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }
  placeTags(r.tags || []);
  applyResultVisibility();
  $('btn-compare').disabled = false;
}

/* ---------- 見比べシート（案D：EN・日本語の対照表示） ---------- */
function compareRow(label, en, ja) {
  if (!en && !ja) return '';
  return `<div class="cmp-row"><h4>${escapeHtml(label)}</h4><p class="cmp-en"><span class="cmp-tag">EN</span>${escapeHtml(en || '')}</p><p class="cmp-ja"><span class="cmp-tag">日本語</span>${escapeHtml(ja || '')}</p></div>`;
}
function openCompare() {
  const r = lastResult;
  if (!r) return;
  let html = '';
  html += compareRow('直訳', r.literal_translation, r.literal_translation_ja);
  html += compareRow('拡張翻訳', r.extended_translation, r.extended_translation_ja);
  (r.tags || []).forEach((tag, i) => {
    html += compareRow(`タグ ${i + 1}`,
      [tag.title, tag.description, tag.why_it_matters].filter(Boolean).join('\n'),
      [tag.title_ja, tag.description_ja, tag.why_it_matters_ja].filter(Boolean).join('\n'));
  });
  html += compareRow('🧳 異なる文化とのギャップ', r.cultural_gap, r.cultural_gap_ja);
  html += compareRow('🗺️ もっと知りたくなる好奇心フック', r.curiosity_hook, r.curiosity_hook_ja);
  $('compare-body').innerHTML = html || '<p class="muted">まだ結果がありません。</p>';
  $('compare').classList.remove('hidden');
}
$('btn-compare').addEventListener('click', openCompare);
$('btn-close-compare').addEventListener('click', () => $('compare').classList.add('hidden'));
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

/* ---------- 対話モード（双方向ライブ化・案1：1台／音声ターン制） ----------
   話者が交互に話し、1発話ごとに拡張翻訳して相手の言語で表示＋読み上げる。
   ターンは翻訳が終わるたびに自動で交代する（手動交代ボタンも用意）。
   認識は1発話ごとに区切る（continuous: false）ので、通常モードの
   「語る」（continuous でテキスト欄に蓄積）とは別系統にしている。 */
let convoTurn = 'ja'; // 'ja' = 日本語話者の番 / 'en' = 英語話者の番
let convoBusy = false;
let convoRecognition = null;

function updateConvoTurnUI() {
  $('convo-turn-label').textContent = convoTurn === 'ja' ? '日本語話者（英語で伝えます）' : 'English speaker（日本語で伝えます）';
  $('convo-input').placeholder = convoTurn === 'ja' ? '音声が使えないときは、ここに日本語で入力して送れます' : 'Or type here in English and send';
}
function setConvoStatus(msg) { $('convo-status').textContent = msg; }

function appendConvoEntry(speaker, original, r) {
  const isJa = speaker === 'ja';
  const literal = isJa ? r.literal_translation : r.literal_translation_ja;
  const extended = isJa ? r.extended_translation : r.extended_translation_ja;
  const note = isJa ? r.cultural_note : r.cultural_note_ja;
  const div = document.createElement('div');
  div.className = 'convo-entry ' + (isJa ? 'from-ja' : 'from-en');
  let html = `<div class="convo-head">${isJa ? '🇯🇵 日本語話者' : '🇺🇸 English speaker'}</div>`;
  html += `<div class="convo-original">${escapeHtml(original)}</div>`;
  html += `<div class="convo-main">${escapeHtml(extended || literal || '')}</div>`;
  if (extended && literal && extended !== literal) html += `<div class="convo-literal">直訳：${escapeHtml(literal)}</div>`;
  if (note) html += `<div class="convo-note">💡 ${escapeHtml(note)}</div>`;
  div.innerHTML = html;
  $('convo-log').appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function runConvoTurn(text) {
  if (convoBusy || !text) return;
  convoBusy = true;
  const speaker = convoTurn;
  const direction = speaker === 'ja' ? 'ja-en' : 'en-ja';
  setConvoStatus(speaker === 'ja' ? '英語に拡張翻訳中…' : '日本語に拡張翻訳中…');
  $('btn-convo-record').disabled = true;
  $('btn-convo-send').disabled = true;
  try {
    const r = $('chk-demo').checked ? { ...MOCK_UTTERANCE[direction] } : await translateUtterance(text, direction);
    appendConvoEntry(speaker, text, r);
    const speakText = speaker === 'ja' ? (r.extended_translation || r.literal_translation) : (r.extended_translation_ja || r.literal_translation_ja);
    if ($('chk-speak').checked && speakText) {
      const u = new SpeechSynthesisUtterance(speakText);
      u.lang = speaker === 'ja' ? 'en-US' : 'ja-JP';
      u.rate = 0.98;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    }
    convoTurn = speaker === 'ja' ? 'en' : 'ja';
    updateConvoTurnUI();
    setConvoStatus('翻訳しました。次の人の番です。');
  } catch (e) {
    setConvoStatus('エラー: ' + e.message);
  } finally {
    convoBusy = false;
    $('btn-convo-record').disabled = false;
    $('btn-convo-send').disabled = false;
  }
}

function toggleConvoRecord() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert('このブラウザは音声認識に未対応です。下の入力欄からテキストで送ってください。'); return; }
  if (convoRecognition) { convoRecognition.stop(); return; }
  convoRecognition = new SR();
  convoRecognition.lang = convoTurn === 'ja' ? 'ja-JP' : 'en-US';
  convoRecognition.interimResults = true;
  convoRecognition.continuous = false;
  let finalText = '';
  convoRecognition.onresult = (ev) => {
    let interim = '';
    finalText = '';
    for (const r of ev.results) {
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    $('convo-hearing').textContent = finalText + interim;
  };
  convoRecognition.onend = () => {
    convoRecognition = null;
    $('btn-convo-record').textContent = '🎙 話す';
    const text = finalText.trim();
    $('convo-hearing').textContent = '';
    if (text) runConvoTurn(text);
  };
  convoRecognition.onerror = () => { convoRecognition = null; $('btn-convo-record').textContent = '🎙 話す'; };
  convoRecognition.start();
  $('btn-convo-record').textContent = '⏹ 停止して翻訳';
}

$('btn-convo-mode').addEventListener('click', () => {
  const panel = $('convo-panel');
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !opening);
  $('btn-convo-mode').classList.toggle('accent', opening);
  if (opening) updateConvoTurnUI();
});
$('btn-convo-record').addEventListener('click', toggleConvoRecord);
$('btn-convo-swap').addEventListener('click', () => {
  if (convoRecognition) convoRecognition.stop();
  convoTurn = convoTurn === 'ja' ? 'en' : 'ja';
  updateConvoTurnUI();
});
$('btn-convo-send').addEventListener('click', () => {
  const text = $('convo-input').value.trim();
  if (!text) return;
  $('convo-input').value = '';
  runConvoTurn(text);
});
$('btn-convo-clear').addEventListener('click', () => { $('convo-log').innerHTML = ''; setConvoStatus(''); });
updateConvoTurnUI();

/* ---------- 設定・初期化 ---------- */
$('btn-settings').addEventListener('click', () => { $('api-key').value = getApiKey(); $('settings').classList.remove('hidden'); });
$('btn-close-settings').addEventListener('click', () => $('settings').classList.add('hidden'));
$('btn-save-key').addEventListener('click', () => { setApiKey($('api-key').value.trim()); $('settings').classList.add('hidden'); });
$('btn-camera').addEventListener('click', toggleCamera);
updateCameraButton();
$('btn-record').addEventListener('click', toggleRecord);
$('btn-translate').addEventListener('click', runTranslate);
