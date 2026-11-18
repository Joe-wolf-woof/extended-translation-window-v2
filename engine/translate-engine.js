/**
 * engine/translate-engine.js ― 拡張翻訳エンジン
 *
 * 単なる直訳ではなく、映像＋語り手の言葉から
 * 「文化・歴史・語り手の感情」の文脈を JSON で抽出する。
 *
 * プロンプト設計（心理学・行動科学の知見を組み込み済み）:
 * - 情報ギャップ理論（Loewenstein）: 「知っているつもり」と「知らないこと」の
 *   落差を1つだけ鋭く提示すると好奇心が最大化する。タグを並べるのではなく
 *   "cultural_gap" を1つに絞らせる。
 * - 自己関連効果: 受け手（英語圏の生活者）の日常と接続する一文を必ず入れる。
 * - 具体性効果: 抽象的な文化説明ではなく、感覚（匂い・手触り・音・温度）で語る。
 * - 物語輸送: 語り手の感情と小さなエピソードを字幕に残す（無難な説明との差分）。
 *   ただしエピソードは入力に実在する場合のみ。2026-11-17の実機実験で、言葉なし
 *   実行時に "grandmother's house" という来歴の捏造が混入したため、プロンプトに
 *   【事実の扱い】として接地ルールを明文化した（一般的な文化知識の補足は可、
 *   語り手個人の事情の創作は禁止）。
 *
 * Gemini キーが無ければモック（チャイのデモデータ）を返す。
 * モデルフォールバックは HowLink と同じ方式（3.x系から試行、404/429/503で次へ）。
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL_CANDIDATES = [
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-flash-latest',
  'gemini-2.5-flash',
];
const KEY_STORAGE = 'etw_gemini_api_key';
const MODEL_STORAGE = 'etw_gemini_model';

export function getApiKey() { return localStorage.getItem(KEY_STORAGE) || ''; }
export function setApiKey(k) { localStorage.setItem(KEY_STORAGE, k); localStorage.removeItem(MODEL_STORAGE); }

const EXTENDED_TRANSLATION_PROMPT = `
あなたは「拡張翻訳」エンジンです。入力は (1) 現地の景色・モノを写した画像、(2) 語り手が自分の言葉（日本語）で語ったテキストです。
受け手は英語圏の一般生活者です。Google翻訳やGoogleレンズのような「正確だが無難で退屈な説明」は禁止です。

やること:
1. literal_translation: 語り手の言葉の忠実な英訳。言葉がない場合は空文字にする。
2. extended_translation: 感情と文脈が伝わる英語の字幕（2文以内）。語り手の声の温度を残すこと。ただし下記の【事実の扱い】を厳守すること。
3. tags: 画像の中のモノ・風景について2〜4個。各タグには、その文化でそれが大切な理由（why_it_matters）と、受け手の日常と接続する一文を含める。x,y は画像内の位置（0〜1）。
4. cultural_gap: 受け手が最も驚く異文化のギャップを「1つだけ」選んで書く（情報ギャップ理論：落差は1つに絞るほど好奇心が強くなる）。
5. curiosity_hook: 読んだ人が次に質問したくなる「問い」を1文で。
6. speaker_emotion: 語り手の感情を英語1語＋短い根拠。言葉がない場合は推定せず、空文字にする。
7. 日本語版: 英語フィールドそれぞれに対応する自然な日本語版も返す。literal_translation_ja は literal_translation に対応する日本語（語り手の言葉を整えた文でよい）。extended_translation_ja は extended_translation の感情と文脈を保った日本語（字幕調、2文以内）。tags の各要素には title_ja / description_ja / why_it_matters_ja を付ける。cultural_gap_ja / curiosity_hook_ja も同様に付ける。日本語版にも【事実の扱い】を厳守すること（英語版にない来歴や事情を日本語版で足さない）。

【事実の扱い（最重要）】
- 事実として書いてよいのは、(a) 語り手の言葉に実際に含まれていること、(b) 画像に実際に写っていること、の2種類だけ。加えて、対象物そのものに関する文化・歴史の一般知識は補ってよい。
- 語り手の個人的な来歴（誰の家か、誰にもらったか、いつ・どこで手に入れたか、家族との思い出など）は、言葉に明示されていない限り絶対に創作しない。"my grandmother's house" のような一人称のエピソードも作らない。
- 言葉がない場合は、語り手の感情・事情・来歴を推定しない。extended_translation は画像の事実と文化的文脈だけで構成する。
- 受け手の日常との接続は「〜に相当する」「〜のようなものだ」という比喩・例えの形でのみ行い、語り手側の事実として書かない。

必ず次のJSON形式だけで答えてください:
{"literal_translation":"","extended_translation":"","literal_translation_ja":"","extended_translation_ja":"","speaker_emotion":"","scene_summary":"","tags":[{"title":"","title_ja":"","x":0.5,"y":0.5,"description":"","description_ja":"","why_it_matters":"","why_it_matters_ja":""}],"cultural_gap":"","cultural_gap_ja":"","curiosity_hook":"","curiosity_hook_ja":""}
`.trim();

export const MOCK_RESULT = {
  literal_translation: "This is masala chai made from whole spices. On cold days, holding the cup with both hands is our family's winter ritual.",
  extended_translation: "He doesn't buy tea bags. He crushes whole spices by hand — because in his home, warmth is something you make, not something you buy.",
  literal_translation_ja: "これはホールスパイスから作るマサラチャイです。寒い日は、両手でカップを持つのが我が家の冬の習慣です。",
  extended_translation_ja: "彼はティーバッグを買わない。ホールスパイスを手で砕く。彼の家では、温かさは買うものではなく、作るものだからだ。",
  speaker_emotion: "proud — he slows down when describing the two-handed grip on the cup",
  scene_summary: "A small home kitchen; a pot of masala chai simmering, whole spices beside it.",
  tags: [
    { title: "Masala chai from whole spices", title_ja: "ホールスパイスのマサラチャイ", x: 0.45, y: 0.55, description: "Cardamom, cloves and ginger, crushed just before brewing — never pre-mixed powder.", description_ja: "カルダモン、クローブ、生姜を、淹れる直前に砕く。混ぜ合わせ済みの粉は使わない。", why_it_matters: "Grinding spices by hand is a small daily act of care; the aroma is the signal that 'someone is home'.", why_it_matters_ja: "スパイスを手で砕くのは、日々の小さな手入れ。その香りが『誰かが家にいる』合図になる。" },
    { title: "The two-handed cup", title_ja: "両手で持つカップ", x: 0.6, y: 0.7, description: "Holding a hot cup with both palms is a winter habit across Japan, for tea and soup alike.", description_ja: "熱いカップを両手のひらで包むのは、日本中で見られる冬の習慣。お茶でも汁物でも同じだ。", why_it_matters: "Warmth through the palms is treated as comfort itself — the drink is almost an excuse.", why_it_matters_ja: "手のひらの温かさ自体が心地よさとして扱われる。飲み物は、ほとんど口実にすぎない。" },
  ],
  cultural_gap: "In Japan, a drink can be a hand-warmer first and a beverage second — convenience stores even sell hot canned drinks purely to hold on cold train platforms.",
  curiosity_hook: "What everyday object in your home would carry this much memory for you?",
  cultural_gap_ja: "日本では、飲み物はまず『手を温めるもの』で、次に飲み物であることがある。コンビニでは、寒い駅のホームで持つためだけに、温かい缶飲料が売られている。",
  curiosity_hook_ja: "あなたの家で、これほど記憶を背負った日用品は何ですか？",
  source: 'mock',
};

function orderedModels() {
  const saved = localStorage.getItem(MODEL_STORAGE);
  if (saved && MODEL_CANDIDATES.includes(saved)) return [saved, ...MODEL_CANDIDATES.filter(m => m !== saved)];
  return MODEL_CANDIDATES;
}

async function callModel(model, key, parts) {
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 3200, thinkingConfig: { thinkingBudget: 0 } },
  };
  const res = await fetch(`${API_BASE}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* noop */ }
    const err = new Error(`Gemini API error: ${res.status} ${detail}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const parsed = JSON.parse(raw);
  parsed.source = `gemini (${model})`;
  return parsed;
}

/**
 * @param {{mimeType:string, data:string}} frame Base64フレーム
 * @param {string} transcript 語り手の言葉
 * @returns {Promise<object>} 拡張翻訳JSON
 */
/* ---------- 質問モード（双方向ライブ化の正しい形） ----------
   CultureLens の「双方向」は話者同士の会話ではなく、人と物／文化の双方向。
   カメラに映る物について質問すると、文化背景ごとの答えが返る。
   答えの狙いは ①親近感（普遍的な感情への共感）②安心感（未知が減る）
   ③好奇心（情報が繋がる楽しさ）。③を連鎖させるため、答えには
   「次に聞きたくなる質問」を1つ添えて返す。 */

const QUESTION_PROMPT = `
あなたは「拡張翻訳 - CultureLens」の質問エンジンです。使い手は、見慣れない土地にいる観光客で、カメラに映っている物や景色について質問します。

答えを通して、使い手に次の3つを生んでください:
- 親近感: その物や文化の背景にある、人間としての普遍的な感情（家族を思う気持ち、季節を楽しむ心、手間をかける愛情など）に触れる
- 安心感: 文化的な情報を具体的に伝え、未知を減らす（それが何なのか、どう使うのか、その場でどう振る舞えばよいのか）
- 好奇心: 直訳では得られない情報の繋がりを1つ示し、「もっと知りたい」を生む

やること:
1. answer: 質問への英語の答え（3文以内）。画像に実際に写っていることと、対象そのものに関する文化・歴史の一般知識だけで答えること。
2. answer_ja: answer の自然な日本語版。
3. next_question: 使い手が次に聞きたくなりそうな短い質問を、英語で1つ。いまの答えの内容と繋がっていること。
4. next_question_ja: next_question の日本語版。

【事実の扱い（最重要）】
- 画像に写っていないこと、質問や文脈に含まれていないことを、事実として断定しない。物の個人的な来歴（誰のものか、誰にもらったか、いつ手に入れたか等）は絶対に創作しない。
- 一般知識で答える場合は、その旨が分かる言い方にする（「一般的には〜」など）。

必ず次のJSON形式だけで答えてください:
{"answer":"","answer_ja":"","next_question":"","next_question_ja":""}
`.trim();

export const MOCK_ANSWER = {
  answer: "This is masala chai brewed from whole spices — cardamom, cloves and ginger crushed just before brewing. In this home, making it by hand is a small daily ritual of care: the aroma filling the room is the signal that someone is home. Warmth here is something you make, not something you buy.",
  answer_ja: "これはホールスパイスから淹れるマサラチャイです。カルダモン、クローブ、生姜を淹れる直前に砕きます。この家では、手で作ることが日々の小さな手入れの儀式です。部屋に満ちる香りが「誰かが家にいる」合図になります。ここでは温かさは、買うものではなく作るものなのです。",
  next_question: "Why do people in Japan hold a hot cup with both hands?",
  next_question_ja: "日本ではなぜ、熱いカップを両手で持つのですか？",
  source: 'mock',
};

/**
 * 質問モード：見ている物について質問し、文化背景ごとの答えを得る。
 * @param {{mimeType:string, data:string}} frame カメラフレーム（無ければ data は空文字）
 * @param {string} question 質問文（日本語でも英語でもよい）
 * @param {string} contextText 直前に表示した拡張翻訳結果の要約（文脈として渡す）
 */
export async function askAboutScene(frame, question, contextText) {
  const key = getApiKey();
  if (!key) return { ...MOCK_ANSWER };
  const parts = [{ text: `${QUESTION_PROMPT}\n\n【文脈：直前に表示した拡張翻訳の結果】\n${contextText || '（まだ拡張翻訳を実行していない）'}\n\n【質問】\n${question}` }];
  if (frame && frame.data) parts.push({ inline_data: { mime_type: frame.mimeType, data: frame.data } });
  let lastError = null;
  for (const model of orderedModels()) {
    try {
      const out = await callModel(model, key, parts);
      localStorage.setItem(MODEL_STORAGE, model);
      return out;
    } catch (err) {
      lastError = err;
      if (![404, 429, 503].includes(err.status)) throw err;
    }
  }
  throw lastError;
}

export async function extendedTranslate(frame, transcript) {
  const key = getApiKey();
  if (!key) return { ...MOCK_RESULT };
  const parts = [
    { text: `${EXTENDED_TRANSLATION_PROMPT}\n\n語り手の言葉（日本語）: ${transcript || '（言葉なし）'}` },
    { inline_data: { mime_type: frame.mimeType, data: frame.data } },
  ];
  let lastError = null;
  for (const model of orderedModels()) {
    try {
      const out = await callModel(model, key, parts);
      localStorage.setItem(MODEL_STORAGE, model);
      return out;
    } catch (err) {
      lastError = err;
      if (![404, 429, 503].includes(err.status)) throw err;
    }
  }
  throw lastError;
}
