/**
 * PdfViewer Component
 * Uses pdf.js to render PDF pages in canvas
 *
 * ★ FIX-7：render effect 保存 RenderTask 句柄，cleanup 调 task.cancel()；await task.promise
 *   包 try/catch 忽略 RenderingCancelledException、其余 setError；renderToken 守卫防过期帧回写。
 *   根治「连点 +/− 或首帧未完成时缩放 → 同 canvas 重入 pdf.js 抛错被吞、停在旧 scale」。
 * ★ FIX-8：容器 ref + 原生 wheel 监听（passive:false），ctrlKey 时 preventDefault + deltaY 缩放。
 * ★ FIX-9：paged / scroll 两种阅读模式切换；scroll 模式多页竖向堆叠 + IntersectionObserver 同步页码。
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

interface PdfViewerProps {
  data: ArrayBuffer | string; // ArrayBuffer or data URL
  currentPage?: number;
  onPageChange?: (page: number) => void;
}

type PdfMode = 'paged' | 'scroll';

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;

export function calculatePdfFitScale(containerWidth: number, containerHeight: number, pageWidth: number, pageHeight: number): number {
  if (containerWidth <= 0 || containerHeight <= 0 || pageWidth <= 0 || pageHeight <= 0) return 1;
  const availableWidth = Math.max(1, containerWidth - 32);
  const availableHeight = Math.max(1, containerHeight - 32);
  const rawScale = Math.min(availableWidth / pageWidth, availableHeight / pageHeight);
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.floor(rawScale * 100) / 100));
}

export function PdfViewer({ data, currentPage = 1, onPageChange }: PdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [page, setPage] = useState(currentPage);
  const [scale, setScale] = useState(1);
  const [mode, setMode] = useState<PdfMode>('paged');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pdfRef = useRef<any>(null);
  const userAdjustedScaleRef = useRef(false);

  // ★ FIX-10：仅记录「最新在飞的 RenderTask」，供 finally 安全回收（=== myTask 才置空）；
  //   取消职责已下放到每个 run 的闭包 myTask（见 paged effect），不再由这个共享 ref 承担。
  const renderTaskRef = useRef<any>(null);
  // ★ 渲染令牌——每次新渲染自增，异步恢复点前比对，过期帧直接丢弃（防 setState 串帧）。
  const renderTokenRef = useRef(0);

  // 容器 ref + 挂载态。
  // ★ FIX-12（修「Ctrl+滚轮永不生效」真因）：旧版 wheel 监听 effect 依赖 [zoomIn,zoomOut,mode]，
  //   但首帧 loading=true 时组件提前 return loading 占位、根本不渲染滚动容器，effect 跑时
  //   containerRef.current 为 null 直接早退；待 loadPDF 完成 setLoading(false) 容器才挂载，
  //   而 effect 依赖未变不会重跑 → 监听「永不绑定」。
  //   改用 callback ref 把节点提升为 state：挂载（null→div）即触发依赖它的 effect 重绑，
  //   对 loading/error/paged↔scroll 切换全部自动正确。containerRef 仍保留供 PdfScrollView
  //   读取（IntersectionObserver root / 滚动定位）。
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const attachContainer = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    setContainerEl(el);
  }, []);

  // ★ FIX-9：scroll 模式下「点翻页按钮要把目标页滚入视图」。用 {page,nonce} 触发，
  //   nonce 每次点击自增以区分「同页重复点」，避免与 IntersectionObserver 回写形成死循环
  //   （observer 只 setPage，不动 scrollRequest）。
  const [scrollRequest, setScrollRequest] = useState<{ page: number; nonce: number }>({ page: currentPage, nonce: 0 });

  const zoomIn = useCallback(() => {
    userAdjustedScaleRef.current = true;
    setScale(s => Math.min(s + ZOOM_STEP, ZOOM_MAX));
  }, []);
  const zoomOut = useCallback(() => {
    userAdjustedScaleRef.current = true;
    setScale(s => Math.max(s - ZOOM_STEP, ZOOM_MIN));
  }, []);

  // ── 加载 PDF 文档（data 变化时重载）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setError('');
        setLoading(true);
        userAdjustedScaleRef.current = false;
        setScale(1);
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        if (typeof data === 'string' && data.startsWith('/workspace/')) {
          throw new Error('Web 模式下请先导入真实 PDF 文件');
        }
        const loadData = typeof data === 'string'
          ? { url: data }
          : { data: data.slice(0) };
        const pdf = await pdfjsLib.getDocument(loadData).promise;
        if (cancelled) return;
        pdfRef.current = pdf;
        setTotalPages(pdf.numPages);
        setLoading(false);
      } catch (err) {
        console.error('[PdfViewer] Load error:', err);
        if (!cancelled) {
          const detail = err instanceof Error ? err.message : '';
          setError(detail.startsWith('Web 模式下')
            ? detail
            : 'PDF 无法打开，文件可能已损坏或格式不受支持');
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [data]);

  useEffect(() => {
    if (!containerEl || totalPages <= 0 || !pdfRef.current || userAdjustedScaleRef.current) return;
    let cancelled = false;
    let frameId = 0;

    const fitPage = async () => {
      if (cancelled || userAdjustedScaleRef.current || !pdfRef.current) return;
      try {
        const firstPage = await pdfRef.current.getPage(1);
        if (cancelled || userAdjustedScaleRef.current) return;
        const viewport = firstPage.getViewport({ scale: 1 });
        const nextScale = calculatePdfFitScale(
          containerEl.clientWidth,
          containerEl.clientHeight,
          viewport.width,
          viewport.height,
        );
        setScale(current => Math.abs(current - nextScale) < 0.01 ? current : nextScale);
      } catch { /* The normal page render path owns visible PDF errors. */ }
    };
    const scheduleFit = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => { void fitPage(); });
    };

    scheduleFit();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleFit) : null;
    observer?.observe(containerEl);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
      observer?.disconnect();
    };
  }, [containerEl, totalPages]);

  // ── paged 模式：渲染当前页到单 canvas。
  //
  // ★ FIX-10（修 FIX-7 缩放回归）：真因——FIX-7 用「共享 renderTaskRef + token 过期守卫 +
  //   cleanup cancel(localTask)」三件套，但 cancel 与 token 的时序在「连点 +/− / 首帧未完成时缩放」
  //   下会互相绊倒：
  //     · cleanup 只 cancel 闭包里的 localTask，而 localTask 在 await getPage 之前恒为 null，
  //       于是「getPage 仍在飞」的那次缩放，cleanup 取消不到任何东西；
  //     · 被取消的 task 抛 RenderingCancelledException 后从 catch 直接 return，renderTaskRef.current
  //       仍指向那个「死 task」，永不置空；
  //     · 共享 renderTaskRef 跨多次 run 复用，叠加 StrictMode 的 mount→cleanup→mount 双调用，
  //       很容易出现「该生效的新一帧 render 被上一拍的 cleanup/cancel 误杀、或新帧被判过期挡回写」，
  //       表现即为：百分比变了（scale state 变了）但 canvas 不重画、停在旧 scale。
  //
  //   重写为「每次 run 自带独立 token + 独立 task 句柄」的可证明正确模型：
  //     1) 进 effect 立刻 ++token 作废所有在飞旧帧；本 run 的 task 存在闭包 myTask（非共享 ref），
  //        cleanup 只取消「本 run 自己创建的那个 task」，绝不误杀别人；
  //     2) 任何异步恢复点都先比对 token，过期即退出（不写 canvas、不报错）；
  //     3) 用 cancelled 标记替代「靠 token 顺便判过期」，cleanup 一旦触发即视为本帧作废，
  //        即便 render 之后才被取消也不会回写「失败」状态；
  //     4) renderToken 仅作「最新有效帧」判据，不再承担「task 句柄回收」职责，彻底解耦。
  //   防重入抛错的好处保留：旧帧 token 失配会主动 cancel，同一 canvas 任意时刻只有最新 task 在画。
  useEffect(() => {
    if (mode !== 'paged') return;
    if (!pdfRef.current || !canvasRef.current) return;

    const token = ++renderTokenRef.current;
    let myTask: any = null;
    let cancelled = false;

    (async () => {
      try {
        const pdfPage = await pdfRef.current.getPage(page);
        if (cancelled || token !== renderTokenRef.current) return; // 本帧已被取代/作废，丢弃。
        const viewport = pdfPage.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d')!;
        // ★ FIX-11（修「只清晰不放大」真因）：批次二只设了 canvas.width/height（=位图渲染分辨率），
        //   但 canvas 的 CSS 显示尺寸由 style 的 maxWidth:100%/height:auto 决定——高分辨率位图被
        //   CSS 缩回容器宽度，于是缩放只让画面变清晰、页面尺寸不变。
        //   标准 PDF 渲染模型：位图分辨率 = scale × devicePixelRatio（清晰），
        //   CSS 显示尺寸 = scale × 基准（viewport.width/height，即真正占据的版面）。
        //   显示尺寸随 scale 真实放大 + 容器 overflow:auto → 超出时出现滚动条。
        const dpr = window.devicePixelRatio || 1;
        // 内在位图尺寸（按 dpr 放大，保证高分屏/放大后依旧锐利）。
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        // CSS 显示尺寸（按 scale 真实放大版面；显式写死，覆盖 style 里的 maxWidth/height auto）。
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        // 把 dpr 缩放并入渲染 viewport，使 pdf.js 直接画到放大后的位图坐标系。
        const renderViewport = dpr === 1 ? viewport : pdfPage.getViewport({ scale: scale * dpr });

        myTask = pdfPage.render({ canvasContext: ctx, viewport: renderViewport });
        renderTaskRef.current = myTask;
        await myTask.promise;
      } catch (err: any) {
        // 被 cleanup 取消时 pdf.js 抛 RenderingCancelledException；本帧已作废，静默忽略。
        const name = err?.name || '';
        if (cancelled || name === 'RenderingCancelledException' || /cancelled/i.test(err?.message || '')) {
          return;
        }
        if (token === renderTokenRef.current) {
          console.error('[PdfViewer] Render error:', err);
          setError('PDF 页面渲染失败，请重新打开文件后再试');
        }
      } finally {
        // 仅当本 run 的 task 仍是「全局当前 task」时才清空，避免把后继帧的句柄误置空。
        if (renderTaskRef.current === myTask) renderTaskRef.current = null;
      }
    })();

    return () => {
      // effect 重跑/卸载：标记本帧作废 + 取消「本 run 自己创建的」task（绝不碰别的 run 的 task）。
      cancelled = true;
      if (myTask) {
        try { myTask.cancel(); } catch { /* ignore */ }
      }
    };
  }, [mode, page, totalPages, scale]);

  // ── FIX-8/FIX-12：Ctrl+滚轮缩放。React onWheel 默认 passive 无法 preventDefault，
  //   故用原生 addEventListener('wheel', fn, { passive:false })。依赖 containerEl（挂载态），
  //   容器真正挂载后才绑定，根治「loading 期监听漏绑」。
  useEffect(() => {
    const el = containerEl;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (e.deltaY < 0) zoomIn();
      else zoomOut();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => { el.removeEventListener('wheel', onWheel); };
  }, [containerEl, zoomIn, zoomOut]);

  // ── FIX-12：鼠标拖动平移（抓手）。放大后页面超出视口时，按住左键拖动即可平移滚动容器，
  //   与主流 PDF 阅读器手感一致。用 Pointer 事件 + setPointerCapture，保证指针拖出元素后仍持续跟随。
  useEffect(() => {
    const el = containerEl;
    if (!el) return;
    let dragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;             // 仅左键
      if (e.pointerType !== 'mouse') return;  // 仅鼠标；触屏/笔走浏览器原生滚动，避免与 pan 双重滚动
      // ★ FIX-12b：排除原生滚动条命中区——offsetX/Y 相对 padding-box，超过 clientWidth/Height 即落在
      //   右侧/底部滚动条带上。此时让浏览器处理原生「拖 thumb 滚动」，绝不启动抓手平移（否则会被
      //   setPointerCapture 抢走事件、且 pan 公式方向与拖 thumb 相反，导致拖滚动条时画面反向跳动）。
      if (e.offsetX > el.clientWidth || e.offsetY > el.clientHeight) return;
      // 无可平移空间（内容未溢出）则不启动，避免「按住拖动毫无反应」的困惑。
      if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      startLeft = el.scrollLeft; startTop = el.scrollTop;
      el.classList.add('is-grabbing');
      e.preventDefault();                     // 阻止拖拽期间的文本/元素选区高亮
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      el.scrollLeft = startLeft - (e.clientX - startX);
      el.scrollTop = startTop - (e.clientY - startY);
    };
    const onUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('is-grabbing');
      try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.classList.remove('is-grabbing'); // 兜底：拖拽中途容器被替换/卸载时清掉残留抓手光标态
    };
  }, [containerEl]);

  // 仅更新页码（IntersectionObserver 回写用，不触发滚动，避免死循环）。
  const setVisiblePage = useCallback((p: number) => {
    const clamped = Math.max(1, Math.min(p, totalPages));
    setPage(clamped);
    onPageChange?.(clamped);
  }, [totalPages, onPageChange]);

  // 翻页按钮用：更新页码 + 在 scroll 模式请求把目标页滚入视图。
  const goPage = useCallback((p: number) => {
    const clamped = Math.max(1, Math.min(p, totalPages));
    setPage(clamped);
    onPageChange?.(clamped);
    setScrollRequest(prev => ({ page: clamped, nonce: prev.nonce + 1 }));
  }, [totalPages, onPageChange]);

  if (loading) {
    return <div className="pdf-viewer-loading" role="status">📄 加载 PDF 中...</div>;
  }

  if (error) {
    return <div className="pdf-viewer-loading pdf-viewer-error" role="alert">⚠️ {error}</div>;
  }

  return (
    <div className="pdf-viewer">
      <div className="pdf-viewer-toolbar">
        <button onClick={() => goPage(page - 1)} disabled={page <= 1} aria-label="上一页" title="上一页">◀</button>
        <span>{page} / {totalPages}</span>
        <button onClick={() => goPage(page + 1)} disabled={page >= totalPages} aria-label="下一页" title="下一页">▶</button>
        <span style={{ margin: '0 8px', opacity: 0.5 }}>|</span>
        <button onClick={zoomOut} disabled={scale <= ZOOM_MIN} aria-label="缩小" title="缩小">−</button>
        <span>{Math.round(scale * 100)}%</span>
        <button onClick={zoomIn} disabled={scale >= ZOOM_MAX} aria-label="放大" title="放大">+</button>
        <span style={{ margin: '0 8px', opacity: 0.5 }}>|</span>
        {/* ★ FIX-9：阅读模式切换（单页翻页 / 竖向连续滚动）。 */}
        <button
          className={mode === 'paged' ? 'pdf-mode-active' : ''}
          onClick={() => setMode('paged')}
          title="单页"
          aria-pressed={mode === 'paged'}
        >
          单页
        </button>
        <button
          className={mode === 'scroll' ? 'pdf-mode-active' : ''}
          onClick={() => setMode('scroll')}
          title="连续滚动"
          aria-pressed={mode === 'scroll'}
        >
          连续
        </button>
      </div>
      {mode === 'paged' ? (
        <div className="pdf-viewer-canvas-container" ref={attachContainer}>
          {/* ★ FIX-11：不再用 maxWidth:100%/height:auto（会把放大后的页面缩回容器宽度，
              导致「只清晰不放大」）。显示尺寸改由 render effect 按 scale 写到 style.width/height，
              页面真实放大、超出容器时由 .pdf-viewer-canvas-container 的 overflow:auto 出滚动条。 */}
          <canvas ref={canvasRef} className="pdf-page-canvas" />
        </div>
      ) : (
        <PdfScrollView
          pdf={pdfRef.current}
          totalPages={totalPages}
          scale={scale}
          activePage={page}
          scrollRequest={scrollRequest}
          containerRef={containerRef}
          attachContainer={attachContainer}
          onVisiblePage={setVisiblePage}
          onError={setError}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// ★ FIX-9：scroll（连续滚动）模式——多页竖向堆叠，每页一 canvas、可见时按需渲染，
//   IntersectionObserver 把最显眼的可见页回写页码。复用 FIX-7 的 RenderTask 取消语义。
// ──────────────────────────────────────────────────────────────────────────
interface PdfScrollViewProps {
  pdf: any;
  totalPages: number;
  scale: number;
  activePage: number;
  scrollRequest: { page: number; nonce: number };
  containerRef: React.RefObject<HTMLDivElement | null>;
  attachContainer: (el: HTMLDivElement | null) => void;
  onVisiblePage: (page: number) => void;
  onError: (message: string) => void;
}

function PdfScrollView({ pdf, totalPages, scale, activePage, scrollRequest, containerRef, attachContainer, onVisiblePage, onError }: PdfScrollViewProps) {
  // 每页一个 canvas ref。
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  // 每页进行中的 RenderTask（取消用）。
  const taskRefs = useRef<(any | null)[]>([]);
  // 每页渲染令牌（防过期帧）。
  const tokenRefs = useRef<number[]>([]);
  // ★ M5-batch3：每页「已成功渲染到的 scale」。scroll 模式下 IntersectionObserver 会在同一页
  //   反复进出 0.1 阈值视口时反复触发 renderPage，旧逻辑无条件 getPage + 完整 render，大 PDF
  //   上下滚动会有可感 CPU 浪费/卡顿。此 ref 让 renderPage 短路掉「scale 未变且该页已按此 scale
  //   渲染过」的重复渲染——仅 scale 变化或首次进入视口才真正重渲，恢复「按需渲染」本意。
  //   渲染失败/被取消时不写入（保持 undefined），下次进入视口会重试。
  const renderedScaleRefs = useRef<number[]>([]);

  // 渲染单页（按需）。
  const renderPage = useCallback(async (pageNum: number) => {
    if (!pdf) return;
    const idx = pageNum - 1;
    const canvas = canvasRefs.current[idx];
    if (!canvas) return;
    // ★ 短路：该页已按当前 scale 成功渲染过且 canvas 仍有内容（width>0）→ 直接 return，
    //   不重复 getPage / render。scale 变化或首次进入视口时 renderedScaleRefs[idx] 不等，正常往下渲。
    if (renderedScaleRefs.current[idx] === scale && canvas.width > 0) return;
    const token = (tokenRefs.current[idx] ?? 0) + 1;
    tokenRefs.current[idx] = token;
    let localTask: any = null;
    try {
      const pdfPage = await pdf.getPage(pageNum);
      if (token !== tokenRefs.current[idx]) return;
      const viewport = pdfPage.getViewport({ scale });
      const ctx = canvas.getContext('2d')!;
      // ★ FIX-11（同 paged 模式）：位图分辨率 = scale × dpr（清晰），
      //   CSS 显示尺寸 = scale × 基准（viewport.width/height，真实放大版面）。
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const renderViewport = dpr === 1 ? viewport : pdfPage.getViewport({ scale: scale * dpr });
      // 重渲前取消本页可能仍在飞的旧 task（如 scale 连变），同 canvas 只留最新 task 在画。
      if (taskRefs.current[idx]) {
        try { taskRefs.current[idx].cancel(); } catch { /* ignore */ }
      }
      // 设置新 width 会清空 canvas 内容；重渲未落地前先标记「此 scale 尚未渲染完成」，
      // 防止渲染中途被并发短路误判为已完成。
      renderedScaleRefs.current[idx] = -1;
      localTask = pdfPage.render({ canvasContext: ctx, viewport: renderViewport });
      taskRefs.current[idx] = localTask;
      await localTask.promise;
      // ★ 渲染成功落地：记录本页已按此 scale 渲染过，供后续重复进出视口时短路。
      if (token === tokenRefs.current[idx]) renderedScaleRefs.current[idx] = scale;
    } catch (err: any) {
      const name = err?.name || '';
      if (name === 'RenderingCancelledException' || /cancelled/i.test(err?.message || '')) return;
      if (token === tokenRefs.current[idx]) {
        console.error('[PdfViewer] Scroll render error:', err);
        onError(err instanceof Error ? err.message : 'PDF 渲染失败');
      }
    } finally {
      // ★ FIX-10：无论成功/被取消，只要本页句柄仍是自己创建的那个就置空，
      //   避免被取消的「死 task」残留在 taskRefs 里（FIX-7 旧逻辑从 catch 直接 return 会漏置空）。
      if (localTask && taskRefs.current[idx] === localTask) taskRefs.current[idx] = null;
    }
  }, [pdf, scale, onError]);

  // 可见性观察：按需渲染进入视口的页 + 把最居中的可见页回写页码。
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const visible = new Set<number>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const pageNum = Number((entry.target as HTMLElement).dataset.page);
        if (!pageNum) continue;
        if (entry.isIntersecting) {
          visible.add(pageNum);
          void renderPage(pageNum);
        } else {
          visible.delete(pageNum);
        }
      }
      // 回写「可见页里页码最小的」为当前页（最稳定，避免来回跳）。
      if (visible.size > 0) {
        const top = Math.min(...visible);
        onVisiblePage(top);
      }
    }, { root, threshold: 0.1 });

    const pageEls = root.querySelectorAll('.pdf-scroll-page');
    pageEls.forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [containerRef, totalPages, renderPage, onVisiblePage]);

  // scale 变化时 renderPage 引用更新 → 下方 IntersectionObserver effect 重建并重画可见页，
  // 故缩放在 scroll 模式自动生效，无需额外副作用。

  // 挂载时把当前 activePage 滚入视图（切到此模式时定位到先前页）。
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const target = root.querySelector(`.pdf-scroll-page[data-page="${activePage}"]`) as HTMLElement | null;
    if (target) target.scrollIntoView({ block: 'start' });
    // 仅挂载时滚一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ★ FIX-9：翻页按钮点击（scrollRequest.nonce 变化）时把目标页滚入视图。
  useEffect(() => {
    if (scrollRequest.nonce === 0) return; // 初始值不触发。
    const root = containerRef.current;
    if (!root) return;
    const target = root.querySelector(`.pdf-scroll-page[data-page="${scrollRequest.page}"]`) as HTMLElement | null;
    if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [scrollRequest, containerRef]);

  return (
    <div className="pdf-viewer-canvas-container pdf-scroll-container" ref={attachContainer}>
      {Array.from({ length: totalPages }, (_, i) => i + 1).map(pageNum => (
        <div className="pdf-scroll-page" data-page={pageNum} key={pageNum}>
          {/* ★ FIX-11：显示尺寸由 renderPage 按 scale 写到 style.width/height，
              移除 maxWidth:100%/height:auto，使连续模式同样真实放大。 */}
          <canvas
            className="pdf-page-canvas"
            ref={el => { canvasRefs.current[pageNum - 1] = el; }}
          />
        </div>
      ))}
    </div>
  );
}
