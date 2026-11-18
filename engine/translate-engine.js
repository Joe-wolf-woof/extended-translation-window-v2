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
/* ---------- 対話モード（双方向ライブ化・案1） ----------
   2人の話者が1台のスマホを挟み、音声で交互に話す。
   1発話ごとに、直訳＋拡張翻訳（感情と文脈）＋文化ニュアンスの注意を返す。
   フィールド名は景色モードと揃え、表示側の pick(en, ja) を再利用できるようにする。 */

const UTTERANCE_PROMPT = (fromDesc, toDesc) => `
あなたは「拡張翻訳」の対話エンジンです。2人の話者が1台のスマホを挟んで会話しています。
入力は1人の話者の発話（${fromDesc}）です。聞き手は${toDesc}です。
Google翻訳のような「正確だが無難」な直訳だけでは不十分です。発話の感情と文化的文脈まで伝えてください。

やること:
1. literal_translation: 発話の忠実な英語訳。発話が英語の場合は、発話を整えた英語にする。
2. extended_translation: 感情と文脈が伝わる英語（2文以内）。話者の声の温度を残すこと。
3. literal_translation_ja: literal_translation に対応する日本語。発話が日本語の場合は、発話を整えた日本語にする。
4. extended_translation_ja: extended_translation の感情と文脈を保った日本語（2文以内）。
5. cultural_note: 発話に文化的な含み（謙遜、婉曲表現、慣用句、敬語の温度など）があり、直訳のままでは聞き手が誤解する可能性がある場合のみ、その注意を英語で1文。無ければ空文字にする。
6. cultural_note_ja: cultural_note の日本語版。

【事実の扱い（最重要）】
- 事実として書いてよいのは、発話に実際に含まれていることだけ。話者の来歴・事情・家族・思い出などを絶対に創作しない。
- 文化に関する一般知識の補足は cultural_note の範囲でのみ行う。

必ず次のJSON形式だけで答えてください:
{"literal_translation":"","extended_translation":"","literal_translation_ja":"","extended_translation_ja":"","cultural_note":"","cultural_note_ja":""}
`.trim();

export const MOCK_UTTERANCE = {
  'ja-en': {
    literal_translation: "Thank you for showing me around today. I'm getting hungry — shall we grab something to eat?",
    extended_translation: "He's genuinely grateful for the tour — and suggesting a meal together is his way of saying he'd like to spend a little more time with you.",
    literal_translation_ja: '今日は案内してくれてありがとう。お腹がすいてきたね、何か食べようか。',
    extended_translation_ja: '彼は案内してくれたことに心から感謝している。そして「一緒に食べよう」という誘いは、もう少し一緒にいたいという気持ちの表れだ。',
    cultural_note: 'In Japan, inviting someone to eat together often signals a wish to deepen the connection, not just hunger.',
    cultural_note_ja: '日本では「一緒に食べよう」という誘いは、空腹だけでなく、相手との距離を縮めたい気持ちの表れであることが多い。',
    source: 'mock',
  },
  'en-ja': {
    literal_translation: "This place is amazing — I've never seen anything like it back home.",
    extended_translation: "She's truly astonished — saying there's nothing like it back home is her way of showing respect for this place.",
    literal_translation_ja: 'ここはすごいですね。私の故郷では、こんなものは見たことがありません。',
    extended_translation_ja: '彼女は本当に驚いている。「故郷にはない」という一言には、この土地への敬意が込められている。',
    cultural_note: 'In English, strong praise like this is usually straightforward — it is not a social formality.',
    cultural_note_ja: '英語圏のこの種の強い称賛は、社交辞令ではなく率直な感想として受け取ってよい場合が多い。',
    source: 'mock',
  },
};

/**
 * 対話モードの1発話を拡張翻訳する。
 * @param {string} text 発話テキスト
 * @param {'ja-en'|'en-ja'} direction 話者の言語 → 聞き手の言語
 */
export async function translateUtterance(text, direction) {
  const key = getApiKey();
  if (!key) return { ...MOCK_UTTERANCE[direction] };
  const fromDesc = direction === 'ja-en' ? '日本語' : '英語';
  const toDesc = direction === 'ja-en' ? '英語圏の生活者' : '日本語話者';
  const parts = [{ text: `${UTTERANCE_PROMPT(fromDesc, toDesc)}\n\n発話: ${text}` }];
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
