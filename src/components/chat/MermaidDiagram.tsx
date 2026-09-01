/**
 * MermaidDiagram —— Mermaid 图表渲染 + 交互式查看（缩放 / 平移 / 全屏）。
 *
 * 从 MessageBubble 内联的 MermaidBlock 抽出并增强，解决主人反馈的两个痛点：
 *   ① 大图被 `max-width:100%` 死压在气泡宽度内 → 节点一多就糊成一团、文字看不清；
 *   ② 渲染出来就是死图，无法手动缩放 / 平移看细节。
 *
 * 设计：
 *   - pending：正在流式书写的未闭合 ```mermaid 块，显源码占位、不喂半截代码给 mermaid
 *     （由上游 MessageBubble.isMermaidFenceClosed 判定，闭合即渲染——「该渲染就渲染」）。
 *   - 渲染成功后用 pan/zoom 查看器承载 svg：工具条（缩小 / 百分比 / 放大 / 适配 / 全屏）
 *     + Ctrl(⌘)+滚轮以鼠标为锚缩放 + 拖拽平移 + 全屏 modal 看大图（Esc / 点背景关闭）。
 *   - 初始 fit-to-contain：整张图适配查看框并居中，再按需放大；svg 去掉 max-width 约束保留自然尺寸。
 *
 * ★ 经多视角对抗 review 修正的关键点（务必保留，别再踩回去）：
 *   - 滚轮缩放用【原生 addEventListener('wheel', fn, {passive:false})】，不用 React onWheel——
 *     React 19 把 wheel 委托成 passive 监听，合成事件里 e.preventDefault() 是 no-op，页面会跟着滚/缩。
 *     这是本仓库 PdfViewer.tsx FIX-8/FIX-12 已记录的坑。
 *   - scale/tx/ty 合并成单个 view 对象、用单次 setView(updater) 更新——updater 必须是纯函数，
 *     绝不在一个 setState 的 updater 里再调别的 setState（StrictMode 双跑会让平移补偿翻倍、缩放跳）。
 *   - 拖拽平移走 ref 直接写 stage.style.transform，仅 mouseup 时 setState 同步——避免每次 mousemove
 *     都整组件重渲染。
 *   - ResizeObserver 兜底：查看框初始在折叠/隐藏区(0 尺寸)展开后，补一次 fit。
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ZoomIn, ZoomOut, Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import { useResolvedTheme } from '@/hooks/useResolvedTheme';

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

// ★ 图表加载性能：mermaid/DOMPurify 模块级单例 import（首次后复用，避免每个图表每次 render 重复 import 解析）；
//   initialize 按 theme 缓存（只在首次/主题切换时跑，省去每图表每次 render 的重复全局初始化开销）。
let _mermaidPromise: Promise<any> | null = null;
let _dompurifyPromise: Promise<any> | null = null;
let _mermaidInitedTheme: string | null = null;
// ★ 失败自愈：import 的 promise 一旦 reject（IO 抖动 / chunk 损坏 / 内存压力），rejected promise 会被
//   ??= 永久缓存（它非 null，不会重赋值），此后本会话所有 MermaidDiagram 实例都拿同一个 rejected promise，
//   图表集体永久失效、必须重启 app。这里在失败时把缓存置回 null，允许后续重试（rethrow 不吞错，调用侧照常感知失败）。
const loadMermaid = () => (_mermaidPromise ??= import('mermaid').then(m => m.default).catch(e => { _mermaidPromise = null; throw e; }));
const loadDOMPurify = () => (_dompurifyPromise ??= import('dompurify').then(m => m.default).catch(e => { _dompurifyPromise = null; throw e; }));

/** 从 mermaid 输出的 svg 字符串解析自然尺寸（优先 viewBox，退化 width/height 属性，兼容 px/%/pt 单位）。 */
function parseSvgSize(svg: string): { w: number; h: number } | null {
  const vb = svg.match(/viewBox="([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)"/);
  if (vb) {
    const w = parseFloat(vb[3]); const h = parseFloat(vb[4]);
    if (w > 0 && h > 0) return { w, h };
  }
  const wm = svg.match(/\bwidth="([\d.]+)[a-z%]*"/i); const hm = svg.match(/\bheight="([\d.]+)[a-z%]*"/i);
  if (wm && hm) {
    const w = parseFloat(wm[1]); const h = parseFloat(hm[1]);
    if (w > 0 && h > 0) return { w, h };
  }
  return null;
}

export function MermaidDiagram({ code, pending }: { code: string; pending?: boolean }) {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');
  const svgRef = useRef<string>(''); // 镜像最新 svg，供 async effect 判断「是否已有旧图」而不读陈旧闭包
  const resolvedTheme = useResolvedTheme();

  useEffect(() => {
    if (pending) {
      // ★ 性能（M7 第四轮，治「图表加载很久」）：未闭合块不渲染（半截代码喂 mermaid 会 throw），
      //   但【提前预热】import mermaid/DOMPurify 大 chunk——loadXxx 是 ??= 幂等缓存，多次调用不重复 import。
      //   流式写图表期间就开始拉 chunk，等块闭合 render 时 import 已就绪 → 闭合即渲染，不再等大 chunk 现拉。
      void loadMermaid().catch(() => undefined);
      void loadDOMPurify().catch(() => undefined);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const mermaid = await loadMermaid();
        const DOMPurify = await loadDOMPurify();
        const isLight = resolvedTheme === 'light';
        const themeKey = isLight ? 'light' : 'dark';
        // initialize 按 theme 缓存——只首次/主题切换时跑（mermaid.initialize 是全局配置，每图表每次 render 重复跑纯浪费）。
        //   节点文字用 SVG <text> 而非 foreignObject(HTML)（避免被 DOMPurify svg profile 清成「只剩框」）；
        //   useMaxWidth:false 让 svg 输出固定 px 宽高(=viewBox)，fit-to-contain 计算才准。
        if (_mermaidInitedTheme !== themeKey) {
          mermaid.initialize({
            startOnLoad: false,
            theme: isLight ? 'default' : 'dark',
            securityLevel: 'strict',
            htmlLabels: false,
            flowchart: { htmlLabels: false, useMaxWidth: false },
            themeVariables: isLight
              ? { primaryColor: '#7c3aed', primaryTextColor: '#111827', lineColor: '#64748b', secondaryColor: '#eef1f7', tertiaryColor: '#f6f7fb' }
              : { primaryColor: '#8b5cf6', primaryTextColor: '#e2e8f0', lineColor: '#64748b', secondaryColor: '#1e293b', tertiaryColor: '#0f172a' },
          });
          _mermaidInitedTheme = themeKey;
        }
        // 先 parse 预校验（不抛）。
        const valid = await mermaid.parse(code, { suppressErrors: true });
        if (!valid) {
          // 已闭合(pending=false)但语法非法：有旧图就静默保留（防红框闪烁），没有旧图则显错误，
          //   否则永远卡在「加载图表...」（render 不抛异常、不进 catch，错误分支成死代码）。
          if (!cancelled) setError(svgRef.current ? '' : '图表语法错误');
          return;
        }
        if (!cancelled) setError('');
        const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const { svg: rendered } = await mermaid.render(id, code);
        const clean = DOMPurify.sanitize(rendered, { USE_PROFILES: { svg: true, html: true }, ADD_TAGS: ['foreignObject'] });
        if (!cancelled) { svgRef.current = clean; setSvg(clean); }
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'Mermaid 渲染失败');
      }
    })();
    return () => { cancelled = true; };
  }, [code, resolvedTheme, pending]);

  if (pending) return <pre className="mermaid-loading">{code}</pre>;
  if (error) {
    return (
      <div className="mermaid-error">
        <span>⚠️ 图表渲染失败</span>
        <pre>{code}</pre>
      </div>
    );
  }
  if (!svg) return <div className="mermaid-loading">加载图表...</div>;
  return <DiagramCanvas svg={svg} />;
}

interface ViewState { scale: number; tx: number; ty: number; }

/** 交互式查看器：固定高度 viewport + transform 缩放/平移层，支持工具条、Ctrl 滚轮、拖拽、全屏。 */
function DiagramCanvas({ svg }: { svg: string }) {
  const [view, setView] = useState<ViewState>({ scale: 1, tx: 0, ty: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const [dragging, setDragging] = useState(false);
  // viewport 用 callback ref（state）——全屏切换会让 viewport 在 portal 里重新挂载，
  //   state 变化驱动 wheel/ResizeObserver effect 重绑，避免漏绑。
  const [viewportEl, setViewportEl] = useState<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view); // 镜像最新 view，供原生事件 handler 读，避免闭包陈旧
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number; lastX: number; lastY: number } | null>(null);
  const naturalRef = useRef(parseSvgSize(svg));

  useEffect(() => { viewRef.current = view; });
  useEffect(() => { naturalRef.current = parseSvgSize(svg); }, [svg]);

  /** 以查看框内 (px,py) 为锚点缩放——该点缩放前后屏幕位置不变。单次 setView，updater 纯函数。 */
  const zoomAt = useCallback((px: number, py: number, factor: number) => {
    setView(v => {
      const next = clampScale(v.scale * factor);
      const ratio = next / v.scale;
      return { scale: next, tx: px - (px - v.tx) * ratio, ty: py - (py - v.ty) * ratio };
    });
  }, []);

  const zoomCenter = useCallback((factor: number) => {
    const el = viewportEl; if (!el) return;
    zoomAt(el.clientWidth / 2, el.clientHeight / 2, factor);
  }, [viewportEl, zoomAt]);

  /** 适配/重置：整图 fit-to-contain 并居中（允许小图放大到 2x 填充，但不超）。 */
  const fit = useCallback(() => {
    const el = viewportEl; if (!el) return;
    const vw = el.clientWidth, vh = el.clientHeight;
    const nat = naturalRef.current;
    if (!nat || vw === 0 || vh === 0) return;
    const s = clampScale(Math.min(vw / nat.w, vh / nat.h, 2));
    setView({ scale: s, tx: (vw - nat.w * s) / 2, ty: (vh - nat.h * s) / 2 });
  }, [viewportEl]);

  // 初始 fit + 尺寸变化补 fit（含折叠/隐藏区 0 尺寸 → 展开拿到真实尺寸；窗口 resize；svg / 全屏切换）。
  useEffect(() => {
    const el = viewportEl;
    if (!el) return;
    let lastKey = '';
    const tryFit = () => {
      const vw = el.clientWidth, vh = el.clientHeight;
      const nat = naturalRef.current;
      if (!nat || vw === 0 || vh === 0) return;
      const key = `${vw}x${vh}`;
      if (key === lastKey) return; // 同尺寸不重复 fit，避免覆盖用户已调好的缩放
      lastKey = key;
      const s = clampScale(Math.min(vw / nat.w, vh / nat.h, 2));
      setView({ scale: s, tx: (vw - nat.w * s) / 2, ty: (vh - nat.h * s) / 2 });
    };
    tryFit();
    const ro = new ResizeObserver(tryFit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewportEl, svg, fullscreen]);

  // 滚轮缩放：原生非 passive 监听，preventDefault 才真正生效（不连带滚/缩页面）。仅 Ctrl/⌘+滚轮。
  useEffect(() => {
    const el = viewportEl;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewportEl, zoomAt]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const v = viewRef.current;
    dragRef.current = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty, lastX: v.tx, lastY: v.ty };
    setDragging(true);
  }, []);

  // 拖拽平移：mousemove 直接写 stage.style.transform（零 React 渲染），mouseup 才 setState 同步真值。
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current; if (!d) return;
      const nx = d.tx + (e.clientX - d.x);
      const ny = d.ty + (e.clientY - d.y);
      d.lastX = nx; d.lastY = ny;
      const stage = stageRef.current;
      if (stage) stage.style.transform = `translate(${nx}px, ${ny}px) scale(${viewRef.current.scale})`;
    };
    const onUp = () => {
      const d = dragRef.current;
      if (d) setView(v => ({ ...v, tx: d.lastX, ty: d.lastY }));
      setDragging(false);
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [dragging]);

  // 全屏时 Esc 退出。
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const body = (
    <div className={`mermaid-diagram${fullscreen ? ' fullscreen' : ''}`}>
      <div className="mermaid-toolbar">
        <button type="button" onClick={() => zoomCenter(1 / 1.25)} title="缩小"><ZoomOut size={14} /></button>
        <span className="mermaid-scale">{Math.round(view.scale * 100)}%</span>
        <button type="button" onClick={() => zoomCenter(1.25)} title="放大"><ZoomIn size={14} /></button>
        <button type="button" onClick={fit} title="适配 / 重置"><RotateCcw size={14} /></button>
        <button type="button" onClick={() => setFullscreen(f => !f)} title={fullscreen ? '退出全屏' : '全屏查看'}>
          {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <span className="mermaid-hint">Ctrl+滚轮缩放 · 拖拽平移</span>
      </div>
      <div
        ref={setViewportEl}
        className={`mermaid-viewport${dragging ? ' dragging' : ''}`}
        onMouseDown={onMouseDown}
      >
        <div
          ref={stageRef}
          className="mermaid-stage"
          style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );

  if (fullscreen) {
    return createPortal(
      <div
        className="mermaid-fullscreen-overlay"
        onMouseDown={(e) => { if (e.target === e.currentTarget) setFullscreen(false); }}
      >
        {body}
      </div>,
      document.body,
    );
  }
  return body;
}
