/* ============================================================
   THE KEYSTONE — 共享證據帳本 ＋ 依賴序 runner。
   每道關卡不只回 pass/fail，而是把 emits 寫進帳本供下游讀；
   runner 依 GATES 的 deps 排序、建 ctx、跑生效關卡、套 severity/
   allowlist/ignore/baseline、彙整 Finding、算 exit code，並持久化
   .dk/report.json。
   零依賴。
   ============================================================ */
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, relative, sep, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { loadTokens, buildManifest, resolve as resolveToken, contrast as wcag, apca } from './tokens.mjs';
import { contractGate, ssotSyncGate } from '../gates/contract.mjs';
import { directionGate } from '../gates/direction.mjs';
import { slopGate } from '../gates/slop.mjs';
import { HEAVY_GATES, HEAVY_GATE_IDS } from '../gates/heavy.mjs';
import { makeFinding } from './finding.mjs';
import { fmsg, sr, pick, LANG } from './i18n.mjs';
import { isUnsafeWriteError, safeWriteFileSync } from './safe-write.mjs';

// 零依賴核心鏈（每次都跑）。
export const GATES = [
  { id: 'contract', deps: [], heavy: false, run: contractGate },
  { id: 'direction', deps: ['contract'], heavy: false, run: directionGate },
  { id: 'ssot-sync', deps: ['contract'], heavy: false, run: ssotSyncGate },
  { id: 'slop', deps: ['contract'], heavy: false, run: slopGate },
];

// 需安裝依賴的重關卡（css-strict / a11y / visual）：只在 --full 或 --gate <id>
// 指名時併入跑序；每道 run() 自行偵測依賴，缺依賴時回 status:'skipped'。
// 併入方式為「每次 run 就地串接」而非永久 mutate GATES，避免同一行程內 full/非-full 交錯汙染。
export { HEAVY_GATES, HEAVY_GATE_IDS };
const HEAVY_ID_SET = new Set(HEAVY_GATE_IDS);
// 掃檔案的關卡在輸入為空時回報 config/no-targets。
const FILE_SCANNING = new Set(['slop', 'css-strict', 'a11y', 'visual']);

/** 全部已知關卡 id（核心＋重關卡），供 CLI 驗證 --gate 是否為真實存在的關卡。 */
export const KNOWN_GATE_IDS = [...GATES.map((g) => g.id), ...HEAVY_GATE_IDS];
export function isKnownGateId(id) { return KNOWN_GATE_IDS.includes(id); }
export function isHeavyGateId(id) { return HEAVY_ID_SET.has(id); }

export function createLedger() {
  const byGate = new Map();     // gateId -> { findings, emits }
  const emitIndex = new Map();  // key -> value（後寫覆蓋；跨關卡共享）
  return {
    put(gateId, { findings = [], emits = {} } = {}) {
      byGate.set(gateId, { findings, emits });
      for (const [k, v] of Object.entries(emits)) emitIndex.set(k, v);
    },
    emit(key, val) { emitIndex.set(key, val); },
    emits(key) { return emitIndex.get(key); },
    get() { return { byGate, emits: Object.fromEntries(emitIndex) }; },
  };
}

/* ============================================================
   per-file 快取（.dk/cache.json）——降低大型 repo 熱跑的讀檔成本。
   條目 key＝repo 相對檔路徑；值＝{ mtimeMs, size, findings, used, ignores }。
   ── 正確性紅線（整個快取設計的地基）──────────────────────────────
   快取的是「gate 產出的 raw slop findings（過濾前）」＋該檔用到的 var(--token)＋該檔
   dk-ignore 註解行位置。severity 覆寫／allowlist／baseline 這些「不改檔案也會變」的層
   **絕不進快取**——它們在 run() 的過濾迴圈每次 run 重新套用，故改 severity/allowlist/
   baseline 不必重掃、卻即刻生效（過濾迴圈吃的是當下重算的 config，不是快取結果）。
   dk-ignore 是行內抑制、其註解寫在檔案裡：改註解＝改檔＝mtime 變＝該檔快取失效重掃，
   故「哪幾行有 ignore 註解」（檔內容的純函式）可安全隨檔快取；但「哪些 finding 被抑制」
   仍每次在過濾迴圈重算（吃當下的 ignore index）。
   ── 全域失效指紋 ─────────────────────────────────────────────
   快取 schema 版本 ＋ dk 版本 ＋ tokenHash ＋ config 指紋（只含會改 raw 輸出的欄位：
   enforce／自訂 slop 規則／字型／required／contrast／targets／ignore；刻意排除 severity／
   allowlist／baseline——見上）。任一變 → loadCache 回空殼整簇作廢。
   ============================================================ */
const CACHE_SCHEMA_VERSION = 1; // 條目形狀或指紋組成改變時 +1（整簇作廢）。

let _dkVersion = null;
function dkVersion() {
  if (_dkVersion != null) return _dkVersion;
  try { _dkVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '0'; }
  catch { _dkVersion = '0'; }
  return _dkVersion;
}
function sha16(str) { return createHash('sha256').update(str).digest('hex').slice(0, 16); }

/* config 指紋分量：只納入會改變 gate RAW 輸出的欄位。刻意排除 severity/allowlist/baseline/
   failOn（過濾/門檻層，每次重算），否則等於把過濾結果偷渡進失效判斷、破壞上方紅線。 */
function configFingerprint(config) {
  const slopRules = (config.slopRules ?? []).map((r) => ({
    id: r.id, pattern: r.pattern ?? null, flags: r.flags ?? null,
    severity: r.severity ?? null, zone: r.zone ?? null, message: r.message ?? null,
    hint: r.hint ?? null, test: typeof r.test === 'function' ? r.test.toString() : null,
  }));
  return JSON.stringify({
    enforce: config.enforce ?? {}, slopRules, fonts: config.fonts ?? {},
    requiredTokens: config.requiredTokens ?? [], contrast: config.contrast ?? {},
    targets: config.targets ?? [], ignore: config.ignore ?? [],
  });
}

/** Fingerprint every resolved policy surface that can change verification meaning. */
export function configEvidenceHash(config) {
  const slopRules = (config.slopRules ?? []).map((rule) => ({
    id: rule.id, pattern: rule.pattern ?? null, flags: rule.flags ?? null,
    severity: rule.severity ?? null, zone: rule.zone ?? null,
    message: rule.message ?? null, hint: rule.hint ?? null,
    test: typeof rule.test === 'function' ? rule.test.toString() : null,
  }));
  return sha16(stableEvidenceStringify({
    runtimeVersion: dkVersion(),
    presetName: config.presetName ?? null,
    tokensPath: config.tokensPath ?? null,
    directionPath: config.directionPath ?? null,
    directionLockPath: config.directionLockPath ?? null,
    directionRequired: config.directionRequired === true,
    targets: config.targets ?? [],
    ignore: config.ignore ?? [],
    failOn: config.failOn ?? null,
    failOnSkipped: config.failOnSkipped === true,
    requiredTokens: config.requiredTokens ?? [],
    contrast: config.contrast ?? {},
    enforce: config.enforce ?? {},
    slopRules,
    fonts: config.fonts ?? {},
    severity: config.severity ?? {},
    allowlist: config.allowlist ?? {},
    baselinePath: config.baselinePath ?? null,
    gates: config.gates ?? {},
    proof: config.proof ?? null,
    bridge: config.bridge ?? null,
  }));
}

function stableEvidenceStringify(value, seen = new WeakSet()) {
  if (typeof value === 'function') return JSON.stringify(value.toString());
  if (typeof value === 'bigint') return JSON.stringify(`${value}n`);
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (seen.has(value)) return JSON.stringify('[Circular]');
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((item) => stableEvidenceStringify(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableEvidenceStringify(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
}

/** A bounded freshness fingerprint over the exact stat set scanned by a run. */
export function sourceEvidenceFingerprint(files) {
  const rows = (files ?? [])
    .map(({ path, size, mtimeMs }) => [String(path), Number(size) || 0, Number(mtimeMs) || 0])
    .sort((left, right) => left[0].localeCompare(right[0]));
  return sha16(JSON.stringify(rows));
}
function cacheFingerprint(config, tokenHash) {
  // 顯示語言（LANG）進全域指紋：快取存的 raw findings 帶 display message（隨語言），故切 DK_LANG
  // 必須整簇作廢——否則 en 熱跑會吐出 zh 舊語言快取的 message（見 i18n.mjs 抬頭）。
  return sha16([CACHE_SCHEMA_VERSION, dkVersion(), LANG, tokenHash, configFingerprint(config)].join('\u0001'));
}
function cacheFilePath(config) { return join(config.cwd ?? process.cwd(), '.dk', 'cache.json'); }

/* 讀 per-file 快取。缺檔／壞檔（JSON 解析失敗）／指紋不符 → 回空殼靜默重建（絕不 crash）。 */
function loadCache(config, fingerprint) {
  try {
    const raw = JSON.parse(readFileSync(cacheFilePath(config), 'utf8'));
    if (raw && raw.schema === CACHE_SCHEMA_VERSION && raw.fingerprint === fingerprint && raw.files && typeof raw.files === 'object') return raw;
  } catch { /* 缺/壞 → 重建 */ }
  return { schema: CACHE_SCHEMA_VERSION, fingerprint, dkVersion: dkVersion(), files: {} };
}
function saveCache(config, cache) {
  try {
    const root = config.cwd ?? process.cwd();
    safeWriteFileSync(root, cacheFilePath(config), JSON.stringify(cache) + '\n');
  } catch (err) {
    // Ordinary cache I/O remains best-effort, but a containment/symlink refusal
    // is a security decision and must be visible to the caller.
    if (isUnsafeWriteError(err)) throw err;
  }
}

// 鏡射 slop.mjs 的 RE_USED_TOKEN：per-file 快取需逐檔歸因「該檔用到的 var(--token)」，
// 才能在快取邊界重建 usedTokens emit 全集（slop gate 只回聚合集合、無法逐檔歸因；命中檔在
// 熱跑不重讀 source，故其 used 必須隨檔快取）。slop 的樣式若改動，dk 版本／schema 版本理應
// 隨之更動而整簇作廢——兩者是這條鏡射的一致性保證。
const RE_USED_TOKEN = /var\(\s*(--[a-z0-9-]+)\s*\)/gi;
function scanUsedTokens(source) {
  const set = new Set(); // 逐檔去重（同 gate 的 Set 語意）：避免快取條目被同 token 的重複引用灌爆。
  for (const m of source.matchAll(RE_USED_TOKEN)) set.add(m[1]);
  return [...set];
}
// dk-ignore 行索引的 per-file 序列化（Map<lineNo,Set> ⇄ { [line]: [ids] }）。
function serializeIgnores(lineMap) {
  const out = {};
  if (lineMap) for (const [line, set] of lineMap) out[line] = [...set];
  return out;
}
function deserializeIgnores(obj) {
  const m = new Map();
  for (const [line, ids] of Object.entries(obj ?? {})) m.set(Number(line), new Set(ids));
  return m;
}

/* 快取分流：把 stat-only 的 stats 依 mtime+size 分「命中（cacheHits）」vs「未命中」，
   **只讀未命中檔的 source**（命中檔完全不讀 → 大 repo 熱跑的 I/O 勝點）。回：
   · scanList：未命中檔 { path, source, mtimeMs, size }（供 gate 掃 + 快取寫回）
   · cacheHits：命中檔 stat（無 source；raw findings 由快取還原） */
function cachePartition(config, stats, tokenHash) {
  const cache = loadCache(config, cacheFingerprint(config, tokenHash));
  const cacheHits = [], scanList = [];
  for (const f of stats) {
    const ent = cache.files[f.path];
    if (ent && ent.mtimeMs === f.mtimeMs && ent.size === f.size) { cacheHits.push(f); continue; }
    try { scanList.push({ path: f.path, source: readFileSync(f.abs, 'utf8'), mtimeMs: f.mtimeMs, size: f.size }); }
    catch { /* 讀不到就跳過（該檔不進掃描，亦不快取） */ }
  }
  return { enabled: true, scanList, cacheHits, cache };
}

/* 快取整合（gate 跑完後呼叫）。回 { cachedRaw, ignoreIndex, hitCount }。
   (a) 未命中檔：從 slop gate 結果取 raw findings 逐檔歸因、連同 used／ignore 行寫回快取。
   (b) 命中檔：raw findings 自快取還原（熱跑不重讀 source；未命中檔的 findings 由 gate 本次
       產出、走既有 raw 迴圈，兩者檔集不交集、無重覆）。
   (c) usedTokens／dk-ignore index：對全部 collected 自快取重建（冷熱一致的全集）。
   (d) 只有全域 run（非 partial 子集）才修剪 collected 之外的舊條目——partial 只見子集，
       不得刪別檔（對齊 merge-by-file 語意）。 */
function cacheIntegrate(config, partition, collected, ledger, isFullDomain) {
  const { enabled, scanList, cacheHits, cache } = partition;
  if (!enabled) return { cachedRaw: [], ignoreIndex: buildIgnoreIndex(collected), hitCount: 0 };

  const slopFindings = ledger.get().byGate.get('slop')?.findings ?? [];
  const missIgnore = buildIgnoreIndex(scanList);
  const bucket = new Map(scanList.map((f) => [f.path, []]));
  for (const f of slopFindings) if (f.file != null && bucket.has(f.file)) bucket.get(f.file).push(f);
  for (const f of scanList) {
    cache.files[f.path] = {
      mtimeMs: f.mtimeMs, size: f.size,
      findings: bucket.get(f.path) ?? [],
      used: scanUsedTokens(f.source),
      ignores: serializeIgnores(missIgnore.get(f.path)),
    };
  }
  const cachedRaw = [];
  for (const f of cacheHits) for (const rf of (cache.files[f.path]?.findings ?? [])) cachedRaw.push(rf);

  const usedSet = new Set();
  const ignoreIndex = new Map();
  for (const f of collected) {
    const ent = cache.files[f.path];
    if (!ent) continue;
    for (const u of ent.used ?? []) usedSet.add(u);
    const ig = deserializeIgnores(ent.ignores);
    if (ig.size) ignoreIndex.set(f.path, ig);
  }
  let pruned = 0;
  if (isFullDomain) {
    const live = new Set(collected.map((f) => f.path));
    for (const p of Object.keys(cache.files)) if (!live.has(p)) { delete cache.files[p]; pruned++; }
  }
  // usedTokens emit 由快取層接管（gate 只回未命中檔的聚合；此為全集、冷熱一致）。
  ledger.emit('usedTokens', [...usedSet].sort());
  // 只在快取內容真的變了才寫回：純熱跑（0 未命中且無修剪）快取與磁碟一致 → 略過 I/O
  //（大 repo 每回合省下整份 cache.json 的序列化與寫入，也減少無謂的磁碟 churn）。
  if (scanList.length > 0 || pruned > 0) saveCache(config, cache);
  return { cachedRaw, ignoreIndex, hitCount: cacheHits.length };
}

/**
 * 依賴序跑整條鏈。
 * @param {ResolvedConfig} config
 * @param {{full?:boolean, only?:string, targets?:string[], cache?:boolean, requireGates?:boolean}} opts
 *   cache: 預設 true；false（--no-cache）走全掃、不讀寫 .dk/cache.json。
 * @returns {{findings, counts, exitCode, ledger, gates, tokenHash, emits, cacheHits}}
 */
export function run(config, opts = {}) {
  const root = config.cwd ?? process.cwd();
  const ledger = createLedger();
  // config 健全性錯誤（loadConfig 產生）：不進 findings 管線（不改 counts/exitCode/terminal），
  // 但獨立持久化，讓 dk report 讀得回「上次 run 其實 config 就壞了」。
  const configErrors = config.errors ?? [];

  // 1) tokens 核心：載入、攤平、算 hash
  let tokens, manifest;
  try {
    tokens = loadTokens(config.tokensPath);
    manifest = buildManifest(tokens);
  } catch (err) {
    return fatal(config, fmsg('ledger.fatalTokens', { path: config.tokensPath, msg: err.message }), configErrors);
  }

  // 2) 決定跑序（是否納入 heavy gates）——需在快取分流前定：快取只在核心關卡 engage。
  const anyConfigEnabled = HEAVY_GATES.some((g) => gateEnabled(config, g.id));
  const wantHeavy = !!opts.full || isHeavyGateId(opts.only) || anyConfigEnabled;

  // 3) glob targets（去 ignore）＋ per-file 快取分流。
  //    快取只保存 slop 的 per-file raw findings；heavy gates 永遠取得完整檔案集合並自行讀取。
  //    只有跑序包含 slop 且未指定 --no-cache 時啟用快取。collected 始終代表本次完整範圍，
  //    因此 filesScanned、scope.files 與 no-targets 在冷熱跑之間保持一致。
  const slopScans = !opts.only || depClosure([...GATES, ...HEAVY_GATES], opts.only).has('slop');
  const cacheEnabled = opts.cache !== false && slopScans;
  let collected, scanList, partition, ctxFiles;
  if (cacheEnabled) {
    collected = collectFileStats(root, opts.targets ?? config.targets, config.ignore);
    partition = cachePartition(config, collected, manifest.tokenHash);
    scanList = partition.scanList; // 未命中檔（帶 source）——slop 只重掃這些。
    if (wantHeavy) {
      // heavy 模式併存快取：heavy gates 讀 ctx.files 的 .path（自行重讀檔內容）→ 命中檔亦須在
      // ctx.files，否則 css-strict/a11y 會漏掉命中檔。給命中檔**空 source** → slop 對其不重掃
      //（其 raw findings 由快取還原），但路徑仍供 heavy gates 使用。命中檔內容因此仍不被讀入
      //（I/O 勝點不變）。
      const hitFiles = partition.cacheHits.map((f) => ({ path: f.path, source: '', mtimeMs: f.mtimeMs, size: f.size }));
      ctxFiles = [...scanList, ...hitFiles].sort((a, b) => (a.path < b.path ? -1 : 1));
    } else {
      ctxFiles = scanList;
    }
  } else {
    collected = collectFiles(root, opts.targets ?? config.targets, config.ignore);
    partition = { enabled: false, scanList: collected, cacheHits: [], cache: null };
    scanList = collected;
    ctxFiles = collected;
  }

  // 4) baseline（棘輪：接受清單）
  const baseline = loadBaseline(config.baselinePath);

  // 5) ctx —— gate 掃 scanList；命中檔的 raw findings 由快取還原（見下方快取整合）。
  const measure = config.contrast?.algorithm === 'apca' ? apca : wcag;
  const ctx = {
    config, root, tokens, manifest,
    resolve: (dotPath, mode) => resolveToken(tokens, dotPath, mode),
    contrast: measure,
    files: ctxFiles,
    emit: (k, v) => ledger.emit(k, v),
    emits: (k) => ledger.emits(k),
    allow: (ruleId, file) => isAllowed(config, ruleId, file),
    baseline,
  };

  // 6) 依賴序跑生效關卡。
  //    重關卡納入條件：
  //      · --full／--gate 指名＝使用者明確要求 attempt；缺依賴時記錄 skipped。
  //      · 否則只有 config.gates.<id>.enabled === true 才 attempt。
  //      · 核心三關永遠跑、不看 enabled（結構上不可被 config 停用）。
  //    --gate <id>（opts.only）會跑目標關卡與其傳遞閉包 deps：
  //      deps 標 auxiliary（跑、供 emits，但不計入 exit code），避免 --gate a11y 時
  //      contract 不跑 → verifiedPairs 缺失 → a11y 對比反查訊息降級。
  const activeGates = wantHeavy ? [...GATES, ...HEAVY_GATES] : GATES;
  const order = topoSort(activeGates);
  const onlyClosure = opts.only ? depClosure(activeGates, opts.only) : null;
  const ran = [];
  const auxiliaryGates = new Set(); // --gate 拉進的 dep（findings 不計入 exit code）
  let ranFileGate = false;
  for (const gate of order) {
    // --gate <id>：只跑目標＋其傳遞閉包 deps，其餘略過（不列入報告）。
    if (onlyClosure && !onlyClosure.has(gate.id)) continue;
    const auxiliary = !!(opts.only && gate.id !== opts.only);
    // 未選取的重關卡明列 skipped，讓報告完整呈現實際跑序。
    if (gate.heavy) {
      const named = gate.id === opts.only;
      if (!opts.full && !named && !gateEnabled(config, gate.id)) {
        ran.push({ id: gate.id, status: 'skipped', reason: sr('heavy.notEnabled'),
          attempted: false, blocking: false, kind: 'disabled' });
        continue;
      }
    }
    let result;
    try { result = gate.run(ctx) ?? {}; }
    catch (err) {
      result = { findings: [makeGateError(gate.id, err)] };
    }
    // 關卡可回 { status:'skipped', reason }（重關卡缺依賴時）——明列 reason，不當作通過。
    if (result.status === 'skipped') {
      ran.push({
        id: gate.id, status: 'skipped', reason: result.reason ?? '略過',
        attempted: true, blocking: !!result.blocking, kind: result.kind ?? 'not-applicable',
        ...(auxiliary && { auxiliary: true }),
      });
      continue;
    }
    ledger.put(gate.id, result);
    if (auxiliary) auxiliaryGates.add(gate.id);
    // 只有「非 auxiliary」的掃檔關卡才計入 ranFileGate（auxiliary dep 不替主目標吵 no-targets）。
    if (FILE_SCANNING.has(gate.id) && !auxiliary) ranFileGate = true;
    ran.push({ id: gate.id, status: 'ran', findings: (result.findings ?? []).length, emits: Object.keys(result.emits ?? {}), ...(auxiliary && { auxiliary: true }) });
  }

  // 7) 快取整合：寫回未命中檔、還原命中檔 raw findings，並取得（快取版）ignore index。
  //    partial 子集 run（explicit targets / --only）只對子集有權威 → 不修剪別檔快取。
  const isFullDomain = !((opts.targets && opts.targets.length) || opts.only);
  const { cachedRaw, ignoreIndex, hitCount } = cacheIntegrate(config, partition, collected, ledger, isFullDomain);

  // 8) 彙整 Finding：套 severity 覆寫、allowlist、// dk-ignore、baseline
  const raw = [];
  for (const [gateId, { findings: gateFindings }] of ledger.get().byGate) {
    const aux = auxiliaryGates.has(gateId);
    for (const f of gateFindings) raw.push(aux ? { ...f, auxiliary: true } : f);
  }
  // 命中檔的 raw slop findings（過濾前）併入——與未命中檔的 gate 產出走同一過濾迴圈（下方）。
  for (const f of cachedRaw) raw.push(f);
  // 掃檔案的關卡跑了、卻掃到 0 檔＝targets 設定有誤：吵一聲（warn），不靜默綠燈。
  //（用 collected 全集判斷，非 scanList——熱跑 scanList 可為 0 卻非「0 檔」。）
  if (ranFileGate && collected.length === 0) {
    raw.push(makeFinding({
      ruleId: 'config/no-targets', severity: 'warn', file: null, line: null, col: null,
      ...fmsg('ledger.noTargets'),
    }));
  }
  const findings = [];
  let suppressed = 0;
  let baselined = 0;
  const seen = new Set(); // 去重：同一處的重複 Finding（內建/自訂重疊）只留一筆（見 dedupeKey）
  // baseline 的 count 是每個 fingerprint 可抑制的精確筆數；去重後才扣除 budget，超額項照常回報。
  // 缺少 count 的相容條目以 Infinity 讀入，直到 --accept 依目前掃描結果重寫精確 count。
  const baselineBudget = baselineBudgets(baseline); // fingerprint -> count | Infinity
  const baselineUsed = new Map();                   // fingerprint -> 本次已抑制筆數
  for (const f of raw) {
    const severity = config.severity?.[f.ruleId] ?? f.severity;
    if (severity === 'off') continue;
    const withSev = { ...f, severity };
    if (f.file && isAllowed(config, f.ruleId, f.file)) continue;
    if (isSuppressed(ignoreIndex, f)) { suppressed++; continue; }
    const key = dedupeKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    const fp = fingerprint(withSev);
    const budget = baselineBudget.get(fp);
    if (budget !== undefined) {
      const used = baselineUsed.get(fp) ?? 0;
      if (used < budget) { baselineUsed.set(fp, used + 1); baselined++; continue; }
      // 超過 budget（同指紋新增了 count 筆以上）→ 落下去如實報成新違規。
    }
    findings.push(withSev);
  }
  findings.sort(bySeverityThenFile);

  // 7) counts + exit code（auxiliary deps 不計入門檻 —— 見 tally）
  const counts = tally(findings);
  const findingExitCode = gateExit(counts, config.failOn ?? 'error');
  const attemptedSkips = ran.filter((g) => g.status === 'skipped' && g.attempted !== false && !g.auxiliary);
  // Explicit full / explicit heavy gate requires its infrastructure prerequisites:
  // missing dependencies, invalid runner output, or execution failure are blocking. Benign states such as an initial missing visual
  // baseline remain visible as `incomplete`; opt into failing every attempted
  // skip with config.failOnSkipped=true (or the programmatic requireGates opt).
  const failEverySkip = opts.requireGates === true || config.failOnSkipped === true;
  const explicitHeavy = !!opts.full || isHeavyGateId(opts.only);
  const skippedExit = attemptedSkips.some((g) => failEverySkip || (explicitHeavy && g.blocking));
  const exitCode = findingExitCode || skippedExit ? 1 : 0;
  const status = findingExitCode ? 'failed' : attemptedSkips.length ? 'incomplete' : 'passed';

  const result = {
    findings, counts, exitCode, status, ledger, gates: ran,
    tokenHash: manifest.tokenHash,
    directionHash: ledger.emits('directionHash') ?? null,
    emits: ledger.get().emits,
    filesScanned: collected.length, // 全集（命中＋未命中）——熱跑與冷跑必然一致。
    cacheHits: hitCount,            // 本次由 per-file 快取還原的檔數（可觀測：熱跑=全集、冷跑=0）。
    sourceFingerprint: sourceEvidenceFingerprint(collected),
    configHash: configEvidenceHash(config),
    runtimeVersion: dkVersion(),
    suppressed,
    baselined,
    configErrors,
    full: !!opts.full,
    // 本次 run 的 scope：供 persist 判斷全量覆寫 vs partial merge-by-file（見 persist）。
    scope: {
      partial: !isFullDomain,
      targets: opts.targets ?? null,
      files: collected.map((f) => f.path),
    },
  };

  persist(config, result);
  return result;
}

/* ---- 依賴排序 ---- */
function topoSort(gates) {
  const byId = new Map(gates.map((g) => [g.id, g]));
  const seen = new Set(), out = [];
  const visit = (g) => {
    if (!g || seen.has(g.id)) return;
    seen.add(g.id);
    for (const d of g.deps ?? []) visit(byId.get(d));
    out.push(g);
  };
  for (const g of gates) visit(g);
  return out;
}

// --gate <id> 的傳遞閉包：目標關卡 id ＋ 其所有（遞迴）deps。供 runner 在 only 模式下
// 連同 deps 一起跑（deps 為 auxiliary），而非只跑目標、把 deps 整個踢掉。
function depClosure(gates, rootId) {
  const byId = new Map(gates.map((g) => [g.id, g]));
  const out = new Set();
  (function visit(id) {
    if (out.has(id) || !byId.has(id)) return;
    out.add(id);
    for (const d of byId.get(id).deps ?? []) visit(d);
  })(rootId);
  return out;
}

/* ---- 檔案蒐集（零依賴 glob）---- */
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 單檔大小上限（2MB）：超過跳過、印 stderr 提示。

/* stat-only 蒐集：walk＋stat＋ignore/target 比對＋2MB 剪枝，回 { path, abs, mtimeMs, size }，
   **不讀 source**。per-file 快取先用它分流（cachePartition），熱跑只讀「未命中檔」的 source——
   命中檔完全不觸碰內容，這是大 repo 熱跑的 I/O 勝點（避免整批重讀）。 */
export function collectFileStats(root, targets, ignore) {
  // 絕對 target 先正規化為 repo-root 相對路徑，確保 glob 能命中同一檔案。
  const normTarget = (t) => {
    if (typeof t !== 'string' || !isAbsolute(t)) return t;
    let rel = relative(root, t);
    if (rel.startsWith('..')) {
      // 目標看似在 root 之外——可能是 symlink 別名（如 macOS /var → /private/var）。
      // 兩端各 realpath 後再算相對路徑（檔不存在則保留原值）。
      try { rel = relative(realpathSync(root), realpathSync(t)); } catch { /* keep */ }
    }
    return rel.split(sep).join('/');
  };
  const targetRes = (targets ?? []).map(normTarget).map(globToRegExp);
  const ignoreRes = (ignore ?? []).map(globToRegExp);
  const out = [];
  const HARD_SKIP = new Set(['node_modules', '.git', '.dk']);

  (function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (ent.isDirectory()) {
        if (HARD_SKIP.has(ent.name)) continue;
        if (ignoreRes.some((re) => re.test(rel) || re.test(rel + '/'))) continue;
        walk(abs);
      } else if (ent.isFile()) {
        if (ignoreRes.some((re) => re.test(rel))) continue;
        if (!targetRes.some((re) => re.test(rel))) continue;
        // 單檔大小上限（2MB）：超過即跳過、不讀入。理由——(1) 與 slop 正則的整檔 matchAll 疊加
        // 是二次攻擊面（見 slop.mjs 的有界量詞），大檔會放大單次成本；(2) 動輒數 MB 的 minified
        // 產物會拖慢整條鏈。絕不靜默：印一行 stderr 讓使用者知道有檔被略過（該檔不進 findings 掃描）。
        try {
          const st = statSync(abs);
          if (st.size > MAX_FILE_BYTES) {
            process.stderr.write(pick(
              `⚠ 略過大檔（>${MAX_FILE_BYTES >> 20}MB，未掃描）：${rel}\n`,
              `⚠ Skipped large file (>${MAX_FILE_BYTES >> 20}MB, not scanned): ${rel}\n`));
            continue;
          }
          out.push({ path: rel, abs, mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* skip */ }
      }
    }
  })(root);

  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

/* 蒐集並讀入 source（{ path, source, mtimeMs, size }）——非快取路徑與既有外部消費者
   （cmdFixSlop 等）用；快取路徑改走 collectFileStats + 只讀未命中檔（見 run/cachePartition）。 */
export function collectFiles(root, targets, ignore) {
  const out = [];
  for (const e of collectFileStats(root, targets, ignore)) {
    try { out.push({ path: e.path, source: readFileSync(e.abs, 'utf8'), mtimeMs: e.mtimeMs, size: e.size }); }
    catch { /* skip unreadable */ }
  }
  return out;
}

/** glob -> RegExp。支援 ** / * / ? / {a,b}。 */
export function globToRegExp(glob) {
  let re = '^', i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; continue; }
        re += '.*'; i += 2; continue;
      }
      re += '[^/]*'; i++; continue;
    }
    if (c === '?') { re += '[^/]'; i++; continue; }
    if (c === '{') {
      let j = i + 1, depth = 1, inner = '';
      while (j < glob.length && depth > 0) {
        if (glob[j] === '{') depth++;
        else if (glob[j] === '}') { depth--; if (depth === 0) break; }
        inner += glob[j]; j++;
      }
      const alts = inner.split(',').map((a) => a.replace(/[.+^${}()|[\]\\?*]/g, '\\$&'));
      re += '(?:' + alts.join('|') + ')';
      i = j + 1; continue;
    }
    if ('.+^$()|[]\\'.includes(c)) { re += '\\' + c; i++; continue; }
    re += c; i++;
  }
  return new RegExp(re + '$');
}

/* ---- allowlist / baseline ---- */
// allowlist glob 依 config 預編譯並以 WeakMap 記憶化；regex 無 g flag，可安全重用且隨 config 回收。
const ALLOW_RE_CACHE = new WeakMap();
function allowlistRes(config) {
  let m = ALLOW_RE_CACHE.get(config);
  if (m) return m;
  m = new Map();
  for (const [ruleId, globs] of Object.entries(config.allowlist ?? {})) m.set(ruleId, (globs ?? []).map(globToRegExp));
  ALLOW_RE_CACHE.set(config, m);
  return m;
}
function isAllowed(config, ruleId, file) {
  if (!file) return false;
  const res = allowlistRes(config).get(ruleId);
  return !!res && res.length > 0 && res.some((re) => re.test(file));
}

function gateEnabled(config, gateId) {
  const map = { 'css-strict': 'cssStrict', a11y: 'a11y', visual: 'visual', bridge: 'bridge' };
  const key = map[gateId] ?? gateId;
  if (gateId === 'bridge') return config.gates?.bridge?.enabled === true || config.bridge?.enabled === true;
  return config.gates?.[key]?.enabled ?? false;
}

/* ---- // dk-ignore 行內抑制（語言中性：只認子字串，不綁註解語法）----
   一條含 `dk-ignore` 的行，抑制「同一行」與「下一行」上的 Finding。
   可選在其後列出 ruleId（如 `dk-ignore slop/hardcoded-color`）只抑制指定規則；
   未列出則抑制該行全部規則。每個抑制都必須在來源中明確標記。 */
// 只認 `category/name` 形狀的 ruleId；不吃裸 `*`——否則 CSS 註解結尾 `*/` 會被
// 誤當成「抑制全部」的萬用字元。未列任何 ruleId = 抑制該行全部（見下方 ids 預設）。
const RE_IGNORE = /dk-ignore((?:[ \t]+[a-z0-9-]+\/[a-z0-9-]+)*)/i;
export function buildIgnoreIndex(files) {
  const index = new Map(); // path -> Map<lineNo, Set<ruleId|'*'>>
  for (const { path, source } of files ?? []) {
    const lines = source.split('\n');
    let byLine = null;
    for (let i = 0; i < lines.length; i++) {
      const m = RE_IGNORE.exec(lines[i]);
      if (!m) continue;
      if (!byLine) index.set(path, (byLine = new Map()));
      const ids = m[1].trim() ? m[1].trim().split(/[ \t]+/) : ['*'];
      const lineNo = i + 1;
      for (const target of [lineNo, lineNo + 1]) { // 同行 + 下一行
        const set = byLine.get(target) ?? byLine.set(target, new Set()).get(target);
        for (const id of ids) set.add(id);
      }
    }
  }
  return index;
}
export function isSuppressed(index, f) {
  if (!f.file || !f.line) return false;
  const set = index.get(f.file)?.get(f.line);
  if (!set) return false;
  return set.has('*') || set.has(f.ruleId);
}

export function loadBaseline(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return { version: 1, accepted: [] }; }
}
// 指紋使用語言中性的 fp，而非 display message，確保 baseline 與 SARIF 身分跨語言穩定。
// 未提供 fp 時退回 message，供語言中性的自訂規則與外部工具文案使用。
export function fingerprint(f) {
  return `${f.ruleId}|${f.file ?? ''}|${f.fp ?? f.message}`;
}
/* Finding 去重鍵。去重原意：拿掉「同一處」內建/自訂規則重疊的重複 Finding。
   有 line/col 時以座標定位；line/col 皆 null（例如 contract 關卡所有 token-level
   Finding 同 file、無座標）時改以 message 區辨——否則同規則的多筆違規會塌成一筆
   （缺 12 個 required token 只報 1 筆、多組對比不足只報第一組）。
   無座標時的鍵與 baseline fingerprint 相同，兩處共用 message-based 身分。 */
function dedupeKey(f) {
  if (f.line != null || f.col != null) return `${f.ruleId}|${f.file ?? ''}|${f.line ?? ''}|${f.col ?? ''}`;
  return fingerprint(f);
}
/* baseline 接受清單 → { fingerprint -> budget } 預算表。
   entry.count 是可抑制筆數；裸字串或缺 count 的相容條目使用 Infinity。
   _budgets 只在單次 run 內記憶化。 */
function baselineBudgets(baseline) {
  if (baseline?._budgets) return baseline._budgets;
  const m = new Map();
  for (const a of baseline?.accepted ?? []) {
    const fp = typeof a === 'string' ? a : (a?.fingerprint ?? null);
    if (fp == null) continue;
    const c = (a && typeof a === 'object' && Number.isFinite(a.count) && a.count >= 0) ? a.count : Infinity;
    // 同指紋多條（不該發生，容錯）：取最大 budget。
    m.set(fp, Math.max(m.get(fp) ?? 0, c));
  }
  if (baseline && typeof baseline === 'object') baseline._budgets = m;
  return m;
}

/* ---- counts / exit code（run() 與 partial-merge 帳本共用）---- */
function tally(findings) {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings ?? []) {
    if (f.auxiliary) continue; // auxiliary（--gate 拉進的 dep）不計入門檻
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }
  return counts;
}
function gateExit(counts, failOn) {
  const gating = failOn === 'warn' ? counts.error + counts.warn > 0 : counts.error > 0;
  return gating ? 1 : 0;
}
function statusFor(counts, gates, exitCode = 0, failOn = 'error') {
  if (gateExit(counts ?? {}, failOn)) return 'failed';
  const attemptedSkip = (gates ?? []).some((g) =>
    g.status === 'skipped' && g.attempted !== false && !g.auxiliary);
  return attemptedSkip ? 'incomplete' : 'passed';
}

/* ---- 排序 / 錯誤 / 持久化 ---- */
const SEV_ORDER = { error: 0, warn: 1, info: 2 };
function bySeverityThenFile(a, b) {
  if (SEV_ORDER[a.severity] !== SEV_ORDER[b.severity]) return SEV_ORDER[a.severity] - SEV_ORDER[b.severity];
  if ((a.file ?? '') !== (b.file ?? '')) return (a.file ?? '') < (b.file ?? '') ? -1 : 1;
  return (a.line ?? 0) - (b.line ?? 0);
}

function makeGateError(gateId, err) {
  const { message, fp } = fmsg('ledger.gateError', { gate: gateId, msg: err.message });
  return {
    ruleId: `${gateId}/internal-error`, severity: 'error', file: null, line: null, col: null,
    message, fp, docs: null,
  };
}

// parts = i18n.fmsg 結果（{ message, fp }）——message 為顯示語言、fp 為指紋參考語（zh-TW）。
function fatal(config, parts, configErrors = []) {
  const f = { ruleId: 'tokens/structure', severity: 'error', file: config.tokensPath, line: null, col: null, message: parts.message, fp: parts.fp };
  const result = {
    findings: [f], counts: { error: 1, warn: 0, info: 0 }, exitCode: 1, status: 'failed',
    ledger: createLedger(), gates: [], tokenHash: null, directionHash: null, emits: {}, filesScanned: 0,
    suppressed: 0, baselined: 0, configErrors, full: false, fatal: true,
  };
  // fatal 也要持久化，避免報告停留在較早的成功快照；無 scope 時採全量覆寫。
  persist(config, result);
  return result;
}

/* 持久化 .dk/report.json。
   全量 verify（無 explicit targets、無 --gate）＝整檔覆寫：本次 run 對整個 repo 有權威。
   partial run（子集或單檔掃描）＝merge-by-file：
   只刷新本次掃過檔案（scope.files）的 findings、保留帳本中其他檔案的既有 findings 與
   沒跑到的 gates。否則單檔快照會把先前全量 verify 的帳本塌掉（filesScanned 3→1、gates 只剩 slop）。
   ── exit code 的責任邊界 ──
   回傳給 CLI 的 result.exitCode 只看「本次掃描的 findings」——partial run 只為它掃的檔負責；
   持久化帳本則保留全貌，counts/exitCode 依合併後的全部 findings 重算。 */
function persist(config, result) {
  try {
    const root = config.cwd ?? process.cwd();
    const dir = join(root, '.dk');
    const reportPath = join(dir, 'report.json');
    const partial = !!result.scope?.partial;

    // 持久化的 findings 一律排除 auxiliary（--gate 拉進的 dep 只作本次 run 的診斷，
    // 非帳本的權威結果；否則多次 partial run 會與既有權威 findings 重覆計數）。
    let findings = (result.findings ?? []).filter((f) => !f.auxiliary);
    let counts = result.counts;
    let exitCode = result.exitCode;
    let gates = result.gates;
    let status = result.status ?? statusFor(result.counts, result.gates, result.exitCode, config.failOn ?? 'error');
    let filesScanned = result.filesScanned;
    let directionHash = result.directionHash ?? null;
    let emits = result.emits ?? {};

    if (partial) {
      const prev = readReportSafely(reportPath);
      if (prev) {
        directionHash ??= prev.directionHash ?? prev.emits?.directionHash ?? null;
        // A partial run may not execute the direction gate. Preserve evidence emitted by untouched gates so a
        // partial snapshot cannot make an approved Taste Lock appear absent.
        emits = { ...(prev.emits ?? {}), ...emits };
        // merge-by-file 的取代域是「本次掃過的檔案 × 本次實際執行的非 auxiliary gate」。
        // 未執行 gate 的 findings 與狀態必須保留；已執行 gate 則可清除掃描後變乾淨的檔案。
        const ranGateIds = new Set((result.gates ?? [])
          .filter((g) => g.status === 'ran' && !g.auxiliary).map((g) => g.id));
        const domainFiles = new Set(result.scope?.files ?? []);
        for (const f of findings) domainFiles.add(f.file ?? null); // 含 token-level（file=tokens.json）
        const inDomain = (f) => ranGateIds.has(gateOfRule(f.ruleId)) && domainFiles.has(f.file ?? null);
        const kept = (prev.findings ?? []).filter((f) => !inDomain(f));
        findings = [...kept, ...findings].sort(bySeverityThenFile);
        gates = mergeGates(prev.gates ?? [], result.gates ?? []); // 只 upsert 非 auxiliary gate
        counts = tally(findings);                                  // 帳本 counts = 全貌
        exitCode = gateExit(counts, config.failOn ?? 'error');     // 帳本 exitCode = 全貌
        filesScanned = Math.max(prev.filesScanned ?? 0, result.filesScanned ?? 0);
        status = statusFor(counts, gates, exitCode, config.failOn ?? 'error');
      }
    }

    const payload = {
      version: 2, // 此 schema 包含 baselined、configErrors 與 fatal。
      generatedAt: new Date().toISOString(),
      preset: config.presetName,
      tokenHash: result.tokenHash,
      runtimeVersion: result.runtimeVersion ?? dkVersion(),
      configHash: result.configHash ?? configEvidenceHash(config),
      sourceFingerprint: partial ? null : result.sourceFingerprint ?? null,
      directionHash,
      direction: summarizeDirection(emits, directionHash),
      counts,
      exitCode,
      status,
      filesScanned,
      suppressed: result.suppressed ?? 0,
      baselined: result.baselined ?? 0,
      // config 健全性錯誤（旁路 findings 管線）也落帳，供 dk report / 機器表面讀回。
      configErrors: summarizeConfigErrors(result.configErrors),
      fatal: !!result.fatal,
      full: result.full,
      partial,
      // scope.files 只在 partial 時寫出（一小撮檔）；全量 run 不列全檔清單以免 report.json 膨脹。
      scope: { targets: result.scope?.targets ?? null, files: partial ? (result.scope?.files ?? []) : null },
      gates,
      findings,
      emits: summarizeEmits(emits),
    };
    // report.json 是機器檔；compact JSON 可降低大型帳本在 watch 中的整檔寫入成本。
    safeWriteFileSync(root, reportPath, JSON.stringify(payload) + '\n');
  } catch (err) {
    // Keep ordinary persistence failures non-fatal for compatibility, but do
    // not turn an actively rejected unsafe path into a green verification.
    if (isUnsafeWriteError(err)) throw err;
  }
}

function readReportSafely(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
/* ruleId → 產生它的 gate id，供 persist 判定本次執行範圍。
   此處維護最小映射以避免 ledger↔report 循環 import。 */
function gateOfRule(ruleId) {
  if (ruleId.startsWith('tokens/ssot')) return 'ssot-sync';
  if (ruleId.startsWith('tokens/')) return 'contract';
  if (ruleId.startsWith('slop/') || ruleId.startsWith('brand/') || ruleId.startsWith('spacing/')) return 'slop';
  if (ruleId.startsWith('css/')) return 'css-strict';
  if (ruleId.startsWith('a11y/')) return 'a11y';
  if (ruleId.startsWith('visual/')) return 'visual';
  if (ruleId.startsWith('config/')) return 'config';
  return ruleId.split('/')[0];
}
// 合併 gates：以帳本既有（prev）為底，用本次「非 auxiliary」跑過的 gate entry upsert。
// auxiliary（--gate 拉進的 dep）不覆寫帳本既有的權威 gate 結果（保留全量 verify 的結論）。
function mergeGates(prev, cur) {
  const out = prev.map((g) => ({ ...g }));
  const idx = new Map(out.map((g, i) => [g.id, i]));
  for (const g of cur ?? []) {
    if (g.auxiliary) continue;
    if (idx.has(g.id)) out[idx.get(g.id)] = g;
    else { idx.set(g.id, out.length); out.push(g); }
  }
  return out;
}

// config 健全性錯誤摘要化持久化：只留機器/人都好讀的欄位（ruleId/severity/message/fix）。
function summarizeConfigErrors(errs) {
  return (errs ?? []).map((e) => ({
    ruleId: e.ruleId, severity: e.severity ?? 'error', message: e.message, fix: e.fix ?? null,
  }));
}

// emits 裡的 manifest.flat 是 Map，且體積大——摘要化以利 JSON。
function summarizeEmits(emits) {
  const out = {};
  for (const [k, v] of Object.entries(emits ?? {})) {
    if (k === 'manifest') { out.manifest = { tokenCount: v?.count, darkCount: v?.darkCount, tokenHash: v?.tokenHash }; continue; }
    out[k] = v;
  }
  return out;
}

function summarizeDirection(emits, directionHash) {
  const e = emits ?? {};
  return {
    status: e.directionStatus ?? 'absent',
    name: e.directionName ?? null,
    hash: directionHash ?? e.directionHash ?? null,
    bindingHash: e.directionBindingHash ?? null,
    locked: e.directionLocked ?? false,
    baselineHash: e.directionBaselineHash ?? null,
    baselineBindingHash: e.directionBaselineBindingHash ?? null,
    approvalStatus: e.directionApprovalStatus ?? 'absent',
    approvalCount: e.directionApprovalCount ?? 0,
    approvalHeadHash: e.directionApprovalHeadHash ?? null,
  };
}

// 讓外部快速探測某路徑是否存在（doctor 用）
export function pathExists(p) { try { statSync(p); return true; } catch { return false; } }
