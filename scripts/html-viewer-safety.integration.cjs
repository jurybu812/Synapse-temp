const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const viewer = fs.readFileSync(path.join(root, 'src/components/editor/HtmlViewer.tsx'), 'utf8');

assert.match(viewer, /sandbox=""/, 'HTML preview must keep an explicit restrictive iframe sandbox');
assert.doesNotMatch(viewer, /sandbox="[^"]*allow-scripts/, 'workspace HTML must not execute scripts in the renderer');
assert.doesNotMatch(viewer, /allow-same-origin/, 'workspace HTML must not inherit the app origin');
assert.match(viewer, /referrerPolicy="no-referrer"/, 'HTML preview must not leak the workspace URL as a referrer');
assert.match(viewer, /Content-Security-Policy/, 'HTML preview must inject a restrictive content security policy');
assert.match(viewer, /default-src \\'none\\'/, 'HTML preview must deny external resources by default');
assert.match(viewer, /frame-src \\'none\\'/, 'HTML preview must deny nested frames');
assert.match(viewer, /href\|xlink:href/, 'HTML preview must neutralize HTML and SVG link destinations');
assert.match(viewer, /http-equiv/, 'HTML preview must inspect meta refresh navigation');
assert.match(viewer, /HTML_PREVIEW_TIMEOUT_MS\s*=\s*5000/, 'HTML preview must stop showing an endless loading state');
assert.match(viewer, /HTML 预览加载超时/, 'HTML preview must expose an actionable timeout state');
assert.match(viewer, /安全预览：脚本、表单、外部资源与链接跳转已禁用/, 'HTML preview must explain its safety boundary');

const sanitizerStart = viewer.indexOf('const HTML_PREVIEW_SECURITY_META');
const sanitizerEnd = viewer.indexOf('\ninterface HtmlViewerProps');
assert.ok(sanitizerStart >= 0 && sanitizerEnd > sanitizerStart, 'could not isolate HTML preview sanitizer');
const sanitizerSource = ts.transpileModule(
  `${viewer.slice(sanitizerStart, sanitizerEnd)}\nmodule.exports = { injectHtmlScrollbar };`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const sanitizerModule = { exports: {} };
vm.runInNewContext(sanitizerSource, { module: sanitizerModule, exports: sanitizerModule.exports });
const { injectHtmlScrollbar } = sanitizerModule.exports;
const sanitized = injectHtmlScrollbar(`<!doctype html><html><head>
  <meta http-equiv=" refresh " content="0;url=https://example.com">
  <meta http-equiv="refres&#x68;" content="0;url=https://example.com/entity-refresh">
  <meta http-equiv="content-security-policy" content="default-src https:">
</head><body>
  <a href="https://example.com">link</a>
  <svg><a xlink:href="https://example.com"><text>svg link</text></a></svg>
</body></html>`);
assert.doesNotMatch(sanitized, /entity-refresh/i, 'entity-encoded meta refresh must be removed');
assert.doesNotMatch(sanitized, /default-src https:/i, 'user-supplied http-equiv directives must be removed');
assert.match(sanitized, /http-equiv="Content-Security-Policy"[^>]*default-src 'none'/i, 'trusted preview CSP must remain injected');
assert.doesNotMatch(sanitized, /\s(?:href|xlink:href)\s*=/i, 'HTML and SVG link destinations must be removed');

console.log('HTML viewer safety integration: all assertions passed');
