/* ============================================================
   三道需安裝依賴的「重」關卡 adapter，各自映射成 Finding[]。
   只在 --full（或 --gate <id> 指名）時跑；缺依賴則**優雅跳過並帶 reason**
   —— 絕不靜默：跳過會在報告裡以 status:'skipped' 明列，避免 --full 出現
   「綠燈卻其實沒跑 a11y」的假通過。
     css-strict：spawn stylelint（.stylelintrc.json）
     a11y：      spawn a11y-runner.mjs（playwright + axe），驅動 config.targets
     visual：    截圖回歸，baseline 綁 tokenHash（無 baseline 時誠實跳過）
   每道 run(ctx) 回 { findings, emits? } 或
   { status:'skipped', reason, blocking, kind }。blocking 表示使用者要求完整
   管線時這是基礎設施失敗，不能以 exit 0 假裝完整通過。
   ============================================================ */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, extname, isAbsolute } from 'node:path';
import { existsSync, lstatSync, statSync, readFileSync } from 'node:fs';
import { makeFinding } from '../core/finding.mjs';
import { fmsg, sr, pick, visualWhy } from '../core/i18n.mjs';
import { isUnsafeWriteError, safeWriteFileSync } from '../core/safe-write.mjs';
import { appProofCaseId, appProofConfigHash, buildAppProofMatrix, normalizeAppProofConfig } from '../proof/app-proof.mjs';
import { normalizeA11yTags } from '../core/a11y-tags.mjs';
import { bridgeGate } from './bridge.mjs';

const A11Y_RUNNER = fileURLToPath(new URL('./a11y-runner.mjs', import.meta.url));
const APP_PROOF_RUNNER = fileURLToPath(new URL('../proof/app-proof-runner.mjs', import.meta.url));
const APP_PROOF_ARTIFACT = '.dk/proof/app-proof.json';

/** 從 repo root 的 node_modules 解析選配依賴（與 CLI doctor 同源）。 */
function canResolve(root, pkg) {
  try { createRequire(join(root, 'x.js')).resolve(pkg); return true; } catch { return false; }
}
function absPath(root, p) { return isAbsolute(p) ? p : join(root, p); }

/* ---- css-strict：stylelint strict-value ---- */
export function cssStrictGate(ctx) {
  const root = ctx.root;
  if (!canResolve(root, 'stylelint')) {
    return gateSkipped(sr('css.noStylelint'), true, 'missing-dependency');
  }
  // 只餵含 CSS 的檔（.css/.scss/.less/.html/.vue/.svelte）給 stylelint。
  const styleFiles = ctx.files
    .map((f) => f.path)
    .filter((p) => /\.(css|scss|less|html?|vue|svelte)$/i.test(p));
  if (!styleFiles.length) return gateSkipped(sr('css.noFiles'), false, 'not-applicable');

  const r = spawnSync('npx', ['stylelint', '--formatter', 'json', ...styleFiles], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  // stylelint exit: 0=無問題, 2=有 lint 問題, 其它=執行失敗。
  if (r.error || (r.status !== 0 && r.status !== 2)) {
    return gateSkipped(sr('css.runFail', { why: r.error?.message ?? 'exit ' + r.status }), true, 'infrastructure-error');
  }
  // stylelint 的 JSON 可能出現在 stdout 或 stderr；取第一個可解析陣列，兩處都無有效
  // payload 時視為基礎設施輸出無效，不能回報零 findings。
  const parsed = parseStylelintJson(r.stdout) ?? parseStylelintJson(r.stderr);
  if (!parsed) return gateSkipped(sr('css.unparsable'), true, 'invalid-output');

  const findings = [];
  for (const file of parsed) {
    const rel = relTo(root, file.source);
    for (const w of file.warnings ?? []) {
      // message 由 stylelint 給（英文、語言中性 → fp 即 message）；只有 fix 是 dk 雙語文案。
      findings.push(makeFinding({
        ruleId: 'css/strict-value',
        severity: w.severity === 'warning' ? 'warn' : 'error',
        file: rel, line: w.line ?? null, col: w.column ?? null,
        evidence: w.rule,
        ...fmsg('heavy.cssStrict.fix', { text: w.text }),
      }));
    }
  }
  return { findings };
}

/* ---- a11y：playwright + axe（驅動 config.targets 的 .html） ---- */
export function a11yGate(ctx) {
  const root = ctx.root;
  // Applicability is a property of the configured targets, not the machine's
  // installed toolchain. A CSS/JS-only project must report not-applicable even
  // when Playwright/axe are absent; only an applicable scan may be blocked by
  // missing infrastructure.
  const htmlFiles = ctx.files.filter((f) => /\.html?$/i.test(f.path)).map((f) => absPath(root, f.path));
  let tags;
  try {
    tags = normalizeA11yTags(
      ctx.config?.gates?.a11y?.tags ?? ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
      'gates.a11y.tags',
    );
  } catch (error) {
    const reason = pick(
      `a11y tags 設定無效，未啟動瀏覽器：${String(error?.message ?? error).split('\n')[0]}`,
      `Invalid a11y tags; browser was not started: ${String(error?.message ?? error).split('\n')[0]}`);
    if (ctx.config?.proof != null) writeIncompleteAppProof(root, 'invalid-configuration', reason, null);
    return gateSkipped(reason, true, 'invalid-configuration');
  }
  let appProof = null;
  if (ctx.config?.proof != null) {
    try { appProof = normalizeAppProofConfig(ctx.config.proof); }
    catch (error) {
      const reason = pick(
        `App Proof 設定無效，未啟動瀏覽器：${String(error?.message ?? error).split('\n')[0]}`,
        `Invalid App Proof config; browser was not started: ${String(error?.message ?? error).split('\n')[0]}`);
      writeIncompleteAppProof(root, 'invalid-configuration', reason, tags);
      return gateSkipped(reason, true, 'invalid-configuration');
    }
  }
  if (!htmlFiles.length && !appProof) return gateSkipped(sr('a11y.noHtml'), false, 'not-applicable');

  const missing = ['@playwright/test', '@axe-core/playwright'].filter((p) => !canResolve(root, p));
  if (missing.length) {
    const reason = sr('a11y.missingDeps', { deps: missing.join(' / ') });
    if (appProof) writeIncompleteAppProof(root, 'missing-dependency', reason, tags);
    return gateSkipped(reason, true, 'missing-dependency');
  }
  // App Proof scans a real dev-server route/state/viewport/theme matrix. With
  // no proof.baseUrl configured, retain the backwards-compatible file:// HTML
  // path. The branches are mutually exclusive so a configured app matrix can
  // never be replaced by an easier local-file pass.
  const r = appProof
    ? spawnSync(process.execPath, [APP_PROOF_RUNNER], {
      cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      input: JSON.stringify({ proof: ctx.config.proof, tags }),
      // Bound a wedged browser while leaving every explicitly allowed case its
      // configured per-operation budget. maxCases itself is bounded by config.
      timeout: Math.min(3_600_000, Math.max(60_000, appProof.timeoutMs * appProof.maxCases + 30_000)),
    })
    : spawnSync(process.execPath, [A11Y_RUNNER, ...htmlFiles], {
      cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, DK_A11Y_TAGS: tags.join(',') },
    });
  if (r.error || (r.status !== 0)) {
    // 缺 chromium／runner 匯入失敗等基礎設施問題 → 誠實跳過（非假紅）。
    const why = (r.stderr || r.error?.message || `exit ${r.status}`).split('\n')[0];
    const kind = appProof && r.status === 2 ? 'invalid-configuration' : 'infrastructure-error';
    const reason = sr('a11y.runFail', { why });
    if (appProof) writeIncompleteAppProof(root, kind, reason, tags);
    return gateSkipped(reason, true, kind);
  }
  let out;
  try { out = JSON.parse(r.stdout || '{}'); }
  catch {
    const reason = sr('a11y.unparsable');
    if (appProof) writeIncompleteAppProof(root, 'invalid-output', reason, tags);
    return gateSkipped(reason, true, 'invalid-output');
  }
  if (!validA11yOutput(out, appProof != null)
      || (appProof && (!validAppProofAgainstPlan(out, appProof, tags) || !validAppProofScreenshots(out, root)))) {
    const reason = pick(
      'a11y runner 回傳不完整或自相矛盾的 coverage；未將它視為通過。',
      'The a11y runner returned incomplete or contradictory coverage; it was not treated as a pass.');
    if (appProof) writeIncompleteAppProof(root, 'invalid-output', reason, tags);
    return gateSkipped(reason, true, 'invalid-output');
  }
  const appProofArtifact = appProof ? APP_PROOF_ARTIFACT : null;
  if (appProofArtifact) {
    // Keep the complete per-case evidence separate from concise report
    // surfaces. The safe-write boundary rejects path/symlink escapes and an
    // artifact write failure prevents the gate from claiming durable proof.
    safeWriteFileSync(root, join(root, appProofArtifact), JSON.stringify(out, null, 2) + '\n');
  }

  const verified = ctx.emits('verifiedPairs') ?? [];
  const findings = a11yResultsToFindings(out.results, root, verified.length);
  return { findings, emits: {
    usedTokensRuntime: out.usedTokens ?? [],
    ...(appProof && {
      appProofCoverage: out.coverage,
      appProofDiscovery: out.discovery,
      appProofSummary: out.summary,
      appProofArtifact,
      appProofConfigHash: out.configHash,
      appProofTags: out.tags,
    }),
  } };
}

/** Fail closed if a child process omits even one promised matrix result. */
export function validA11yOutput(out, appMode = false) {
  if (!out || !Array.isArray(out.results) || !Array.isArray(out.usedTokens)) return false;
  if (!appMode) return true;
  let normalizedTags;
  try { normalizedTags = normalizeA11yTags(out.tags, 'tags'); }
  catch { return false; }
  if (JSON.stringify(out.tags) !== JSON.stringify(normalizedTags)) return false;
  const coverage = out.coverage;
  if (out.schemaVersion !== 2 || out.kind !== 'axion-app-proof' || out.coverageStatus !== (coverage?.failedCases ? 'incomplete' : 'complete')
      || !/^[a-f0-9]{64}$/i.test(out.configHash ?? '')
      || !coverage || !Number.isInteger(coverage.plannedCases) || coverage.plannedCases < 1) return false;
  if (!Number.isInteger(coverage.completedCases) || !Number.isInteger(coverage.failedCases)) return false;
  if (!Number.isInteger(coverage.screenshotCases)) return false;
  if (out.results.length !== coverage.plannedCases
      || coverage.completedCases + coverage.failedCases !== coverage.plannedCases) return false;
  let failed = 0;
  let violations = 0;
  const ids = new Set();
  const matrices = new Set();
  const usedTokens = new Set();
  for (const result of out.results) {
    if (!result || typeof result.id !== 'string' || typeof result.target !== 'string'
        || typeof result.url !== 'string' || !result.matrix || typeof result.matrix !== 'object') return false;
    const dimensions = ['route', 'state', 'viewport', 'theme'];
    if (!dimensions.every((key) => typeof result.matrix[key] === 'string' && result.matrix[key])) return false;
    const signature = JSON.stringify(dimensions.map((key) => result.matrix[key]));
    if (ids.has(result.id) || matrices.has(signature) || result.id !== appProofCaseId(result.matrix)) return false;
    ids.add(result.id); matrices.add(signature);
    if (!Array.isArray(result.usedTokens) || !result.usedTokens.every((token) => /^--[A-Za-z0-9_-]+$/.test(token))) return false;
    for (const token of result.usedTokens) usedTokens.add(token);
    if (result.error != null) { if (typeof result.error !== 'string' || !result.error) return false; failed++; }
    else {
      if (!Array.isArray(result.violations)) return false;
      violations += result.violations.length;
      const shot = result.screenshot;
      if (!shot || shot.path !== `.dk/proof/screenshots/${result.id}.png`
          || !/^[a-f0-9]{64}$/i.test(shot.sha256 ?? '')
          || !Number.isInteger(shot.bytes) || shot.bytes < 1
          || !Number.isInteger(shot.width) || shot.width < 1
          || !Number.isInteger(shot.height) || shot.height < 1
          || shot.fullPage !== true) return false;
    }
  }
  const declaredTokens = [...out.usedTokens];
  if (new Set(declaredTokens).size !== declaredTokens.length
      || declaredTokens.some((token) => !/^--[A-Za-z0-9_-]+$/.test(token))
      || JSON.stringify([...usedTokens].sort()) !== JSON.stringify([...declaredTokens].sort())) return false;
  if (!out.summary || out.summary.cases !== coverage.plannedCases
      || out.summary.failed !== failed || out.summary.violations !== violations
      || out.qualityStatus !== (violations ? 'violations' : 'clean')) return false;
  return failed === coverage.failedCases
    && coverage.completedCases === coverage.plannedCases - failed
    && coverage.screenshotCases === coverage.completedCases;
}

/** Bind child output to the exact normalized plan the parent launched. Auto
 * discovery is bounded by the concrete same-origin route list the child
 * returned; explicit plans must match their declared routes byte-for-byte. */
export function validAppProofAgainstPlan(out, plan, expectedTags = []) {
  try {
    const tags = normalizeA11yTags(expectedTags, 'gates.a11y.tags');
    if (JSON.stringify(out.tags) !== JSON.stringify(tags)
        || out.configHash !== appProofConfigHash(plan, tags)) return false;
    const actualRoutes = out.coverage.routes;
    if (!Array.isArray(actualRoutes) || !actualRoutes.length) return false;
    const routes = actualRoutes.map((route) => {
      if (!route || typeof route.name !== 'string' || !route.name
          || typeof route.url !== 'string') throw new Error('bad route');
      const url = new URL(route.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== new URL(plan.baseUrl).origin) throw new Error('bad origin');
      return { name: route.name, path: `${url.pathname}${url.search}` || '/', url: url.href, waitFor: null, states: null };
    });
    if (plan.routes !== 'auto') {
      const declared = plan.routes.map((route) => ({ name: route.name, url: route.url }));
      if (JSON.stringify(actualRoutes) !== JSON.stringify(declared)) return false;
    }
    const expected = buildAppProofMatrix(plan, plan.routes === 'auto' ? routes : plan.routes);
    if (expected.length !== out.results.length || expected.length !== out.coverage.plannedCases) return false;
    const byId = new Map(expected.map((entry) => [entry.id, entry]));
    for (const result of out.results) {
      const target = byId.get(result.id);
      if (!target || result.url !== target.url || JSON.stringify(result.matrix) !== JSON.stringify(target.matrix)) return false;
      if (!result.error && (result.screenshot.width !== target.viewport.width || result.screenshot.height !== target.viewport.height)) return false;
    }
    const expectedStates = [...new Set(expected.map((entry) => entry.state.name))];
    const expectedViewports = plan.viewports;
    const expectedThemes = plan.themes.map((theme) => ({ name: theme.name, colorScheme: theme.colorScheme }));
    return JSON.stringify(out.coverage.states) === JSON.stringify(expectedStates)
      && JSON.stringify(out.coverage.viewports) === JSON.stringify(expectedViewports)
      && JSON.stringify(out.coverage.themes) === JSON.stringify(expectedThemes);
  } catch { return false; }
}

/** A metadata claim is not durable proof until every referenced PNG exists and
 * matches its byte count + digest under the project root. */
export function validAppProofScreenshots(out, root) {
  try {
    for (const result of out?.results ?? []) {
      if (result.error) continue;
      const shot = result.screenshot;
      let current = root;
      for (const part of shot.path.split('/').filter(Boolean)) {
        current = join(current, part);
        const stat = lstatSync(current);
        if (stat.isSymbolicLink()) return false;
      }
      if (!lstatSync(current).isFile()) return false;
      const bytes = readFileSync(current);
      if (bytes.length !== shot.bytes || createHash('sha256').update(bytes).digest('hex') !== shot.sha256) return false;
    }
    return true;
  } catch { return false; }
}

function writeIncompleteAppProof(root, kind, reason, tags = null) {
  safeWriteFileSync(root, join(root, APP_PROOF_ARTIFACT), JSON.stringify({
    schemaVersion: 2,
    kind: 'axion-app-proof',
    coverageStatus: 'incomplete',
    generatedAt: new Date().toISOString(),
    tags,
    failure: { kind, reason },
    coverage: { plannedCases: null, completedCases: 0, failedCases: null },
    results: [],
    usedTokens: [],
  }, null, 2) + '\n');
}

/* a11y-runner 的 results → Finding[]。抽成純函式（不需 spawn／瀏覽器）以便無依賴環境也能單元回歸：
     · v.error（單檔渲染失敗，runner 結構化回報）→ a11y/scan-failed（error；該 target 未驗證，不能 exit 0）。
     · 否則逐一映射 axe violations → a11y/axe（對比違規用 verifiedCount 反查）。
   verifiedCount = contract 播出的 verifiedPairs 筆數。 */
export function a11yResultsToFindings(results, root, verifiedCount = 0) {
  const findings = [];
  for (const v of results ?? []) {
    const rel = v.target ?? relTo(root, v.file);
    const appTarget = typeof v.url === 'string';
    // 單檔掃描失敗（runner 結構化回報）：該 target 沒有可宣稱的 a11y 結果，
    // Treat an unscanned target as an error; warn would pass at the default threshold.
    if (v.error) {
      const zh = `a11y 未能掃描此${appTarget ? '真實 App 矩陣案例' : '檔'}（已排除於結果、非通過）：${v.error}`;
      const en = `a11y could not scan this ${appTarget ? 'real-app matrix case' : 'file'} (excluded from results — not a pass): ${v.error}`;
      findings.push(makeFinding({
        ruleId: 'a11y/scan-failed', severity: 'error', file: rel, line: null, col: null,
        message: pick(zh, en), fp: zh,
        fix: appTarget
          ? pick('確認 dev server 可連線、route 回傳成功，並修正該 state 的 selector/action；任何未完成案例都不算通過。',
            'Ensure the dev server is reachable and the route succeeds, then fix the state selector/action; an incomplete case is never a pass.')
          : pick('確認該 target 存在且可由 file:// 渲染（不存在的檔／載入逾時／頁面 JS 例外都會使該檔無法掃描）。',
            'Ensure the target exists and renders under file:// (a missing file, load timeout, or page JS exception all make it unscannable).'),
        meta: { scanFailed: true, reason: v.error, ...(appTarget && { url: v.url, matrix: v.matrix }) },
      }));
      continue;
    }
    for (const viol of v.violations ?? []) {
      const isContrast = viol.id === 'color-contrast';
      const selector = (viol.nodes?.[0]?.target ?? []).join(' ');
      // 對比違規：因契約已在 token 層證明對比，這裡多半是「用了非 token / 未驗證的配色」（viol.help 為 axe 英文）。
      const msg = isContrast
        ? fmsg('a11y.contrast', { id: viol.id, selector, n: verifiedCount })
        : fmsg('a11y.generic', { id: viol.id, help: viol.help, selector });
      const fixPart = viol.helpUrl ? fmsg('a11y.fix.url', { url: viol.helpUrl }) : fmsg('a11y.fix.noUrl');
      findings.push(makeFinding({
        ruleId: 'a11y/axe',
        severity: viol.impact === 'minor' ? 'warn' : 'error',
        file: rel, line: null, col: null,
        evidence: viol.nodes?.[0]?.html?.slice(0, 120) ?? viol.id,
        message: msg.message, fp: msg.fp, fix: fixPart.fix,
        ...(appTarget && { meta: { url: v.url, matrix: v.matrix } }),
      }));
    }
  }
  return findings;
}

/* ---- visual：截圖回歸（baseline 綁 tokenHash 作稽核脈絡，不作因果豁免） ----
   tokenHash 是重要的變更脈絡，但全域 hash 無法證明某張快照的 pixel diff 是由該 token
   造成。因此任何 pixel diff 都維持 error；hash 只寫入 metadata / 修正提示，絕不自動降級。
     · 建立/更新 baseline 時同步把當下 tokenHash 存進 sidecar（.dk/visual-baseline.json）。
     · verify 比對：畫面有差時讀回 sidecar 的 baselineHash 與當下 currentHash——
     · 更新入口 DK_UPDATE_VISUAL（封裝 playwright --update-snapshots）：既有 baseline 有任何
         pixel diff 時一律拒絕普通更新（fail-closed），須 =force / =accept 明確蓋章。
   只有未建立 baseline 的首次建立可用 DK_UPDATE_VISUAL=1；這不是接受一筆既有回歸。
   Without a baseline the gate is explicitly incomplete. */
export function visualGate(ctx) {
  const root = ctx.root;
  if (!canResolve(root, '@playwright/test')) {
    return gateSkipped(sr('visual.noPlaywright'), true, 'missing-dependency');
  }
  const specRel = 'gates/visual.spec.mjs';
  if (!existsSync(join(root, specRel))) {
    return gateSkipped(sr('visual.noSpec', { spec: specRel }), true, 'missing-configuration');
  }
  const snapDir = join(root, 'gates', 'visual.spec.mjs-snapshots');
  const hasBaseline = existsSync(snapDir) && safeIsDir(snapDir);
  // 當下帳本 hash：優先取 contract 播出的 tokenHash，退回 ctx.manifest。
  const currentHash = ctx.emits?.('tokenHash') ?? ctx.manifest?.tokenHash ?? null;
  const currentDirectionHash = ctx.emits?.('directionHash') ?? null;
  const currentDirectionBindingHash = ctx.emits?.('directionBindingHash') ?? null;
  const meta = readVisualMeta(root);
  const baselineHash = meta?.tokenHash ?? null;
  const baselineDirectionHash = meta?.directionHash ?? null;
  const baselineDirectionBindingHash = meta?.directionBindingHash ?? null;
  // The visual matrix is part of the gate invocation, not dead config. The
  // scaffold spec consumes these values from the environment and expands one
  // deterministic screenshot case per viewport × theme.
  const visualMatrix = resolveVisualMatrix(ctx.config);

  // 更新入口：DK_UPDATE_VISUAL（1 / true / force / accept）。封裝 playwright --update-snapshots，
  // 更新時把當下 tokenHash 寫進 sidecar；既有 baseline 有 pixel diff 時 fail-closed（除非 =force）。
  const rawUpd = String(process.env.DK_UPDATE_VISUAL ?? '').trim().toLowerCase();
  const wantUpdate = rawUpd && rawUpd !== '0' && rawUpd !== 'false';
  const forced = rawUpd === 'force' || rawUpd === 'accept';

  if (wantUpdate) {
    // 尚無 baseline → 初次建立：直接寫快照 + sidecar hash。
    if (!hasBaseline) {
      const r = runPlaywright(root, specRel, true, visualMatrix);
      if (r.error) return gateSkipped(sr('visual.pwFail', { msg: r.error.message }), true, 'infrastructure-error');
      if (r.status !== 0) return gateSkipped(sr('visual.createFail', { diag: firstDiagLine(r) }), true, 'infrastructure-error');
      writeVisualMeta(root, currentHash, currentDirectionHash, currentDirectionBindingHash);
      return { findings: [infoVisual(fmsg('visual.created', { hash: short(currentHash) }))],
        emits: { visualBaselineHash: currentHash, visualBaselineDirectionHash: currentDirectionHash,
          visualBaselineDirectionBindingHash: currentDirectionBindingHash } };
    }
    // 已有 baseline → 先不更新地探測是否有畫面差異。
    const probe = runPlaywright(root, specRel, false, visualMatrix);
    if (probe.error) return gateSkipped(sr('visual.pwFail', { msg: probe.error.message }), true, 'infrastructure-error');
    if (probe.status === 0) {
      // 畫面一致：token 或許變了但畫面沒變——僅把 sidecar hash 同步到當下（不需重拍）。
      writeVisualMeta(root, currentHash, currentDirectionHash, currentDirectionBindingHash);
      return { findings: [infoVisual(fmsg('visual.synced', { hash: short(currentHash) }))],
        emits: { visualBaselineHash: currentHash, visualBaselineDirectionHash: currentDirectionHash,
          visualBaselineDirectionBindingHash: currentDirectionBindingHash } };
    }
    // 畫面有差：全域 tokenHash 不是 snapshot-level 因果證據。既有 baseline 一律
    // fail-closed；只有 force/accept 能明確接受新像素。
    const tokenHashChanged = baselineHash != null && baselineHash !== currentHash;
    if (!forced) {
      return { findings: [makeFinding({
        ruleId: 'visual/regression', severity: 'error', file: null, line: null, col: null,
        message: pick(
          `拒絕更新視覺基準：畫面已變；全域 tokenHash${tokenHashChanged ? ` 也已改變（${short(baselineHash)}→${short(currentHash)}），但這不構成該快照差異的因果證明` : ` 未變（${short(currentHash)}）`}。`,
          `Refusing to update the visual baseline: pixels changed; the global tokenHash ${tokenHashChanged ? `also changed (${short(baselineHash)}→${short(currentHash)}), but that does not prove causation for this snapshot` : `did not change (${short(currentHash)})`}.`),
        fp: `拒絕更新視覺基準：畫面已變；全域 tokenHash${tokenHashChanged ? ' 已改變但不構成快照因果證明' : ' 未變'}。`,
        fix: pick(
          '先人工審查 diff；確認為刻意變更後，用 DK_UPDATE_VISUAL=force 明確接受。',
          'Review the diff; after confirming it is intentional, explicitly accept it with DK_UPDATE_VISUAL=force.'),
        evidence: firstDiagLine(probe),
        meta: { verification: 'UNVERIFIED', tokenHashChanged, baselineHash, currentHash,
          directionHashChanged: baselineDirectionHash !== currentDirectionHash,
          baselineDirectionHash, currentDirectionHash,
          directionBindingHashChanged: baselineDirectionBindingHash !== currentDirectionBindingHash,
          baselineDirectionBindingHash, currentDirectionBindingHash, updateRefused: true },
      })] };
    }
    // force / accept → 接受新基準，改寫 sidecar hash。
    const r = runPlaywright(root, specRel, true, visualMatrix);
    if (r.error) return gateSkipped(sr('visual.pwFail', { msg: r.error.message }), true, 'infrastructure-error');
    if (r.status !== 0) return gateSkipped(sr('visual.updateFail', { diag: firstDiagLine(r) }), true, 'infrastructure-error');
    writeVisualMeta(root, currentHash, currentDirectionHash, currentDirectionBindingHash);
    const why = visualWhy('force');
    return { findings: [infoVisual(fmsg('visual.updated', { why }))],
      emits: { visualBaselineHash: currentHash, visualBaselineDirectionHash: currentDirectionHash,
        visualBaselineDirectionBindingHash: currentDirectionBindingHash } };
  }

  // ── 一般 verify 路徑 ──
  if (!hasBaseline) {
    return gateSkipped(sr('visual.noBaseline'), false, 'uninitialized');
  }
  const r = runPlaywright(root, specRel, false, visualMatrix);
  if (r.error) return gateSkipped(sr('visual.pwFail', { msg: r.error.message }), true, 'infrastructure-error');
  if (r.status === 0) return { findings: [], emits: {
    visualBaselineHash: baselineHash,
    visualBaselineDirectionHash: baselineDirectionHash,
    visualBaselineDirectionBindingHash: baselineDirectionBindingHash,
  } }; // 畫面與基準一致
  // 畫面有差 → tokenHash 只提供稽核脈絡，不作豁免。
  const evidence = firstDiagLine(r);
  if (baselineHash == null) {
    // 基準無 tokenHash 記錄（例如以裸 playwright 建立、未經 dk）：缺少稽核脈絡，仍保守判 error。
    return { findings: [makeFinding({
      ruleId: 'visual/regression', severity: 'error', file: null, line: null, col: null,
      ...fmsg('visual.noHash'),
      evidence,
      meta: { verification: 'UNVERIFIED', tokenHashContext: 'missing', baselineHash: null, currentHash },
    })] };
  }
  if (baselineHash !== currentHash) {
    // tokenHash 改變只是上下文，不是 pixel diff 的 snapshot-level 因果證據；維持 error。
    return { findings: [makeFinding({
      ruleId: 'visual/regression', severity: 'error', file: null, line: null, col: null,
      message: pick(
        `視覺回歸：畫面與基準不符；tokenHash 也已改變（${short(baselineHash)}→${short(currentHash)}），但全域 hash 不能證明這張快照的差異由 token 造成。`,
        `Visual regression: pixels differ from baseline; tokenHash also changed (${short(baselineHash)}→${short(currentHash)}), but a global hash cannot prove that tokens caused this snapshot diff.`),
      fp: '視覺回歸：畫面與基準不符；tokenHash 已改變但不構成快照因果證明。',
      fix: pick(
        '人工審查 pixel diff；確認為刻意變更後，以 DK_UPDATE_VISUAL=force 更新基準。',
        'Review the pixel diff; after confirming it is intentional, update with DK_UPDATE_VISUAL=force.'),
      evidence,
      meta: { verification: 'UNVERIFIED', tokenHashChanged: true, baselineHash, currentHash },
    })] };
  }
  // tokenHash 未變、畫面卻跑掉：差異位於 token 來源之外或渲染環境，仍需人工審查（error，擋關）。
  return { findings: [makeFinding({
    ruleId: 'visual/regression', severity: 'error', file: null, line: null, col: null,
    ...fmsg('visual.unchangedHash', { hash: short(currentHash) }),
    evidence,
    meta: { verification: 'UNVERIFIED', tokenHashChanged: false, baselineHash, currentHash },
  })] };
}

/* 視覺 baseline sidecar（.dk/visual-baseline.json）：記錄建立/更新基準當下的 tokenHash，
   只供稽核脈絡，不作 snapshot 因果豁免。刻意與截圖分離。 */
function visualMetaPath(root) { return join(root, '.dk', 'visual-baseline.json'); }
function readVisualMeta(root) {
  try { return JSON.parse(readFileSync(visualMetaPath(root), 'utf8')); } catch { return null; }
}
function writeVisualMeta(root, tokenHash, directionHash = null, directionBindingHash = null) {
  try {
    const p = visualMetaPath(root);
    const prev = readVisualMeta(root);
    safeWriteFileSync(root, p, JSON.stringify({
      version: 3,
      tokenHash: tokenHash ?? null,
      directionHash: directionHash ?? null,
      directionBindingHash: directionBindingHash ?? null,
      createdAt: prev?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      note: '建立/更新視覺基準當下的 tokenHash + directionHash + directionBindingHash；只作稽核脈絡，任何 pixel diff 仍維持 error。',
    }, null, 2) + '\n');
  } catch (err) {
    // Ordinary sidecar I/O remains best-effort. A rejected unsafe path is part
    // of the gate result and must not be hidden as a successful visual run.
    if (isUnsafeWriteError(err)) throw err;
  }
}
const DEFAULT_VISUAL_VIEWPORTS = [375, 1024];
const DEFAULT_VISUAL_THEMES = ['light', 'dark'];

/**
 * Resolve the visual coverage matrix from dk config. Filtering here keeps the
 * runner safe even for JavaScript configs that did not pass through JSON
 * Schema tooling. An invalid/empty list falls back to the documented defaults
 * instead of registering zero Playwright tests and creating a false pass.
 */
export function resolveVisualMatrix(config) {
  const visual = config?.gates?.visual ?? {};
  const rawViewports = Array.isArray(visual.viewports) ? visual.viewports : DEFAULT_VISUAL_VIEWPORTS;
  const rawThemes = Array.isArray(visual.themes) ? visual.themes : DEFAULT_VISUAL_THEMES;
  const viewports = [...new Set(rawViewports.filter((v) => Number.isInteger(v) && v > 0 && v <= 10000))];
  const themes = [...new Set(rawThemes
    .filter((v) => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean))];
  return {
    viewports: viewports.length ? viewports : [...DEFAULT_VISUAL_VIEWPORTS],
    themes: themes.length ? themes : [...DEFAULT_VISUAL_THEMES],
  };
}

/** Environment contract consumed by the scaffold and available to custom specs. */
export function visualMatrixEnvironment(visualMatrix) {
  return {
    DK_VISUAL_MATRIX: JSON.stringify(visualMatrix),
    DK_VISUAL_VIEWPORTS: JSON.stringify(visualMatrix.viewports),
    DK_VISUAL_THEMES: JSON.stringify(visualMatrix.themes),
  };
}

// 封裝 playwright 執行（update=true 時 --update-snapshots，建立/更新基準）。
// DK_VISUAL_MATRIX is the canonical hand-off to the scaffold. The split vars
// remain intentionally exposed so custom specs can consume either shape.
function runPlaywright(root, specRel, update, visualMatrix) {
  const args = ['playwright', 'test', specRel];
  if (update) args.push('--update-snapshots');
  return spawnSync('npx', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      ...visualMatrixEnvironment(visualMatrix),
    },
  });
}
function firstDiagLine(r) {
  return (r.stdout || r.stderr || '').split('\n').find((l) => /diff|snapshot|screenshot|✘|×|failed|error/i.test(l))?.trim() ?? '';
}
function short(h) { return h ? String(h).slice(0, 8) : pick('（無）', '(none)'); }
// parts = i18n.fmsg 結果（{ message, fp, fix? }）；info 級視覺訊息（fix 空字串維持既有行為）。
function infoVisual(parts) {
  return makeFinding({ ruleId: 'visual/regression', severity: 'info', file: null, line: null, col: null,
    message: parts.message, fp: parts.fp, fix: parts.fix ?? '' });
}
export function parseStylelintJson(text) {
  if (!text || !text.trim()) return null;
  // Node/npm combinations (notably npm invoked through older Node releases) may
  // prepend engine/deprecation warnings to npx stdout or stderr. The stylelint
  // payload is still a valid JSON array; extract a balanced array instead of
  // treating harmless launcher noise as a skipped gate.
  const clean = text.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '').trim();
  try { const v = JSON.parse(clean); if (Array.isArray(v)) return v; } catch { /* try embedded payload */ }
  for (let start = clean.indexOf('['); start >= 0; start = clean.indexOf('[', start + 1)) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < clean.length; i++) {
      const ch = clean[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '[') depth++;
      else if (ch === ']' && --depth === 0) {
        try {
          const v = JSON.parse(clean.slice(start, i + 1));
          if (Array.isArray(v)) return v;
        } catch { /* warning text may itself contain brackets; keep searching */ }
        break;
      }
    }
  }
  return null;
}

function gateSkipped(reason, blocking = false, kind = 'not-applicable') {
  return { status: 'skipped', reason, blocking, kind };
}

/* GateSpec[]（依賴序：a11y 讀 slop/contract 的 emits；visual 讀 tokenHash）。 */
export const HEAVY_GATES = [
  { id: 'css-strict', deps: ['slop'], heavy: true, run: cssStrictGate },
  { id: 'a11y', deps: ['slop'], heavy: true, run: a11yGate },
  { id: 'visual', deps: ['contract', 'direction'], heavy: true, run: visualGate },
  { id: 'bridge', deps: [], heavy: true, run: bridgeGate },
];
export const HEAVY_GATE_IDS = HEAVY_GATES.map((g) => g.id);

/* ---- helpers ---- */
function relTo(root, p) {
  if (!p) return null;
  if (isAbsolute(p) && p.startsWith(root)) return p.slice(root.length + 1);
  return p;
}
function safeIsDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }
// extname imported for potential future use in this adapter surface.
void extname;
