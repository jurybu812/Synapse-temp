import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch } from 'react-redux';
import { User, Bot, Upload, X, Check } from 'lucide-react';
import { addNotification } from '@/store/slices/notifications';

/**
 * ★ #19 个性化：头像上传 + 压缩 + 方框裁剪组件。
 *
 * 流程：选图 → FileReader 读 dataURL → 装进 <img> 拿原始像素 → 弹裁剪模态
 *   （固定方形裁剪框 + 拖动图片定位 + 滚轮缩放）→ 确定时把裁剪框可视区域
 *   等比绘到 OUT_SIZE×OUT_SIZE canvas → toDataURL('image/jpeg', 0.85) 输出。
 *
 * 「自动压缩大图」由裁剪天然完成：无论原图多大，最终只输出 256×256 的 JPEG，
 *   dataURL 体积可控（实测人像 ~10-25KB），适合塞进 localStorage 的 settings。
 *
 * 样式全内联（不碰 chat.css / layout.css），组件自包含，可被多处复用。
 */

const OUT_SIZE = 256; // 输出头像边长（px）；同时是「压缩到 ≤256×256」的落地点。
const BOX_SIZE = 240; // 裁剪框在模态里的显示边长（px）。
const MIN_SCALE_PAD = 1; // 最小缩放=「图片恰好铺满裁剪框」时的比例，不允许更小（防出现空边）。

interface AvatarUploadProps {
  /** 当前头像 dataURL（空=未设置，显示占位图标）。 */
  value?: string;
  /** 输出新 dataURL；传 undefined 表示清除。 */
  onChange: (dataUrl: string | undefined) => void;
  /** 占位图标类型：用户 or AI。 */
  variant: 'user' | 'ai';
  /** 无障碍/标题用文案，如「用户头像」。 */
  label: string;
}

export function AvatarUpload({ value, onChange, variant, label }: AvatarUploadProps) {
  const dispatch = useDispatch();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 裁剪模态：null=未打开；否则存待裁剪原图 HTMLImageElement。
  const [cropImage, setCropImage] = useState<HTMLImageElement | null>(null);

  const handlePick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // 统一的失败反馈：弹通知，避免「选了图却毫无反应、裁剪框永远 null」的静默 no-op。
  const reportFailure = useCallback((message: string) => {
    dispatch(addNotification({ type: 'error', title: '头像读取失败', message }));
  }, [dispatch]);

  const handleFile = useCallback((file: File | undefined) => {
    if (!file) return;
    // 仅按 MIME 过滤——改了扩展名的非图文件可能仍带 image/* MIME，故后续 img.onerror 还要兜一道（解码失败）。
    if (!file.type.startsWith('image/')) {
      reportFailure(`「${file.name}」不是受支持的图片格式，请选择 PNG / JPEG / WebP 等图片。`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      if (!url) {
        reportFailure('图片内容为空或无法读取，请换一张图片试试。');
        return;
      }
      const img = new Image();
      img.onload = () => setCropImage(img);
      // 改扩展名的非图文件 / 损坏图：MIME 蒙混过关但解码失败 → 这里兜底反馈，不再静默卡死。
      img.onerror = () => reportFailure('图片解码失败（文件可能已损坏或并非真正的图片），请换一张图片试试。');
      img.src = url;
    };
    // FileReader 自身读取失败（权限/IO 异常）：补 onerror，否则 onload 不触发、用户毫无反馈。
    reader.onerror = () => reportFailure('读取文件失败，请检查文件后重试。');
    reader.readAsDataURL(file);
  }, [reportFailure]);

  const Placeholder = variant === 'user' ? User : Bot;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div
        title={label}
        style={{
          width: 48,
          height: 48,
          borderRadius: 10,
          overflow: 'hidden',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: value
            ? 'transparent'
            : variant === 'user'
              ? 'var(--syn-primary)'
              : 'linear-gradient(135deg, var(--syn-primary), var(--syn-info))',
          color: 'white',
          border: '1px solid var(--syn-border)',
        }}
      >
        {value
          ? <img src={value} alt={label} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <Placeholder size={22} />}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="settings-btn" onClick={handlePick}>
          <Upload size={14} style={{ marginRight: 4, verticalAlign: 'text-bottom' }} />
          {value ? '更换' : '上传'}
        </button>
        {value && (
          <button type="button" className="settings-btn danger" onClick={() => onChange(undefined)}>
            清除
          </button>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={e => {
          handleFile(e.target.files?.[0]);
          // 重置 value 让「连续选同一张图」也能触发 onChange。
          e.target.value = '';
        }}
      />
      {cropImage && (
        <AvatarCropModal
          image={cropImage}
          onCancel={() => setCropImage(null)}
          onConfirm={(dataUrl) => {
            onChange(dataUrl);
            setCropImage(null);
          }}
        />
      )}
    </div>
  );
}

interface AvatarCropModalProps {
  image: HTMLImageElement;
  onCancel: () => void;
  onConfirm: (dataUrl: string) => void;
}

/**
 * 裁剪模态：固定 BOX_SIZE 方形裁剪框，图片在框内可拖动定位、滚轮缩放。
 *   - scale：当前缩放系数（基于「铺满框」的最小比例 baseScale 之上）。
 *   - offset：图片中心相对裁剪框中心的像素偏移（拖动改它）。
 * 实时用一个 <canvas> 预览（与最终输出同口径，所见即所得）。
 */
function AvatarCropModal({ image, onCancel, onConfirm }: AvatarCropModalProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // baseScale：让图片【较短边】恰好铺满裁剪框所需的缩放（保证框内永远有内容、无空边）。
  const baseScale = Math.max(BOX_SIZE / image.width, BOX_SIZE / image.height);
  const [scale, setScale] = useState(1); // 用户额外缩放倍数（× baseScale），下限 MIN_SCALE_PAD。
  const [offset, setOffset] = useState({ x: 0, y: 0 }); // 图片中心相对框中心的偏移（显示坐标系 px）。
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  // 把偏移夹紧到「图片始终盖满裁剪框」的合法范围内（拖太远会露空边，这里限制住）。
  const clampOffset = useCallback((nx: number, ny: number, s: number) => {
    const dispW = image.width * baseScale * s;
    const dispH = image.height * baseScale * s;
    const maxX = Math.max(0, (dispW - BOX_SIZE) / 2);
    const maxY = Math.max(0, (dispH - BOX_SIZE) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, nx)),
      y: Math.min(maxY, Math.max(-maxY, ny)),
    };
  }, [image.width, image.height, baseScale]);

  // 实时绘制预览：把图片按 baseScale*scale 缩放、按 offset 平移后画到 BOX_SIZE canvas（裁剪框=canvas 全幅）。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, BOX_SIZE, BOX_SIZE);
    const dispW = image.width * baseScale * scale;
    const dispH = image.height * baseScale * scale;
    // 图片左上角在 canvas 坐标：框中心 + offset - 图片半宽高。
    const dx = BOX_SIZE / 2 + offset.x - dispW / 2;
    const dy = BOX_SIZE / 2 + offset.y - dispH / 2;
    ctx.drawImage(image, dx, dy, dispW, dispH);
  }, [image, baseScale, scale, offset]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y };
  }, [offset.x, offset.y]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const nx = d.baseX + (e.clientX - d.startX);
    const ny = d.baseY + (e.clientY - d.startY);
    setOffset(clampOffset(nx, ny, scale));
  }, [clampOffset, scale]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    const next = Math.min(4, Math.max(MIN_SCALE_PAD, scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    setScale(next);
    // 缩放后重新夹紧偏移（缩小可能让原偏移越界露边）。
    setOffset(prev => clampOffset(prev.x, prev.y, next));
  }, [scale, clampOffset]);

  const handleConfirm = useCallback(() => {
    // 输出 canvas：把裁剪框可视区域等比放大到 OUT_SIZE 输出（ratio = OUT_SIZE / BOX_SIZE）。
    const out = document.createElement('canvas');
    out.width = OUT_SIZE;
    out.height = OUT_SIZE;
    const ctx = out.getContext('2d');
    if (!ctx) { onCancel(); return; }
    const ratio = OUT_SIZE / BOX_SIZE;
    const dispW = image.width * baseScale * scale * ratio;
    const dispH = image.height * baseScale * scale * ratio;
    const dx = OUT_SIZE / 2 + offset.x * ratio - dispW / 2;
    const dy = OUT_SIZE / 2 + offset.y * ratio - dispH / 2;
    ctx.drawImage(image, dx, dy, dispW, dispH);
    onConfirm(out.toDataURL('image/jpeg', 0.85));
  }, [image, baseScale, scale, offset, onConfirm, onCancel]);

  // 模态用 portal 挂 body，避免被设置面板的 overflow/transform 截断。
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="裁剪头像"
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--syn-bg-elevated)',
          border: '1px solid var(--syn-border)',
          borderRadius: 14,
          padding: 20,
          width: BOX_SIZE + 40,
          boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
          color: 'var(--syn-text-primary)',
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>裁剪头像</span>
          <button type="button" onClick={onCancel} aria-label="关闭" style={{ background: 'none', border: 'none', color: 'var(--syn-text-secondary)', cursor: 'pointer', padding: 2 }}>
            <X size={16} />
          </button>
        </div>
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          style={{
            width: BOX_SIZE,
            height: BOX_SIZE,
            borderRadius: 10,
            overflow: 'hidden',
            position: 'relative',
            cursor: 'grab',
            touchAction: 'none',
            border: '2px solid var(--syn-primary)',
            margin: '0 auto',
            background: 'var(--syn-bg-base)',
          }}
        >
          <canvas ref={canvasRef} width={BOX_SIZE} height={BOX_SIZE} style={{ display: 'block' }} />
        </div>
        <div style={{ marginTop: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--syn-text-secondary)', display: 'block', marginBottom: 4 }}>缩放</label>
          <input
            type="range"
            min={MIN_SCALE_PAD}
            max={4}
            step={0.01}
            value={scale}
            onChange={e => {
              const next = Number(e.target.value);
              setScale(next);
              setOffset(prev => clampOffset(prev.x, prev.y, next));
            }}
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ fontSize: 11, color: 'var(--syn-text-muted)', marginTop: 6 }}>
          拖动图片定位，滚轮或滑块缩放；确定后压缩为 {OUT_SIZE}×{OUT_SIZE} 头像。
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button type="button" className="settings-btn" onClick={onCancel}>取消</button>
          <button
            type="button"
            className="settings-btn"
            onClick={handleConfirm}
            style={{ background: 'var(--syn-primary)', color: 'white', borderColor: 'var(--syn-primary)' }}
          >
            <Check size={14} style={{ marginRight: 4, verticalAlign: 'text-bottom' }} />
            确定
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
