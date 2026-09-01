/**
 * RichTextInput —— Plan_5_M6 contenteditable 富文本输入框（替代 textarea）。
 *
 * 非受控：DOM 是唯一真值，React 不回写 innerHTML（避免重渲染重置光标 / 打断 IME，对抗审查 P9）。
 * 父组件通过 ref（RichTextInputHandle）命令式插/删 token、提取内容、回填重建；通过回调感知输入变化与键盘。
 *
 * 焊死的对抗审查点：
 *   P1/P2  compositionend 先 normalize 再 queueMicrotask 处理（合并 IME 拆开节点 + 避开重复 input）
 *   P7     两段式退格删 atomic token（findAtomicTokenBeforeCaret 命中才整块删，否则默认删字符）
 *   P9     memo + 全 useCallback（父需传稳定回调）；placeholder 走 CSS dataset，不触发 React 重渲染
 *   P11    Enter 统一 insertLineBreak（避 Chromium 默认 <div> 分块）；粘贴多行交 extract 块级兜底
 *   P16    粘贴图片优先走父附件链路（不被纯文本 preventDefault 堵死）
 *   P4     粘贴只取 text/plain（杜绝富文本 / HTML 注入）
 */

import { type ClipboardEvent, type KeyboardEvent, type Ref, forwardRef, memo, useCallback, useImperativeHandle, useRef } from 'react';
import type { RichTextInputHandle } from '@/services/inputCommands/richInput/types';
import {
  insertTokenAtTrigger, insertTokenAtCaret, extractContent, isEditorEmpty,
  findAtomicTokenBeforeCaret, removeTokenSpan, setEditorContent,
} from '@/services/inputCommands/richInput/domUtils';
import { detectAtTrigger } from '@/services/inputCommands/richInput/atTrigger';

interface Props {
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  maxHeight?: number;
  /** 输入变化后（父刷新 @ 菜单 + 更新发送可用性）。 */
  onContentChange?: () => void;
  /** 键盘事件先交父处理（菜单导航 / Ctrl+Enter 发送 / Esc）。返回 true=父已消费，编辑器不再默认处理。 */
  onEditorKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => boolean;
  /** 粘贴图片 → 父走附件链路（P16）。 */
  onPasteFiles?: (files: File[]) => void;
}

const MAX_HEIGHT_DEFAULT = 200;

function RichTextInputInner(
  { placeholder = '', ariaLabel = '输入消息', disabled, className, maxHeight = MAX_HEIGHT_DEFAULT, onContentChange, onEditorKeyDown, onPasteFiles }: Props,
  ref: Ref<RichTextInputHandle>,
) {
  const editorRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);

  const autoResize = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
  }, [maxHeight]);

  // placeholder 切换走 CSS dataset（无 React 重渲染，P9）。
  const syncEmpty = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    el.dataset.empty = isEditorEmpty(el) ? 'true' : 'false';
  }, []);

  const handleInput = useCallback(() => {
    if (isComposingRef.current) return; // IME 期间 no-op（P1/P2）
    syncEmpty();
    autoResize();
    onContentChange?.();
  }, [syncEmpty, autoResize, onContentChange]);

  useImperativeHandle(ref, (): RichTextInputHandle => ({
    insertTokenAt(trigger, t) {
      const el = editorRef.current; if (!el) return;
      el.focus(); // ★ bug1 止血：插入前把选区拉回编辑器，避免 portal 菜单点击后 focusNode 漂到外部 DOM（与 insertToken 对称）
      insertTokenAtTrigger(el, trigger, t);
      syncEmpty(); requestAnimationFrame(autoResize); // P18：插 token 后 rAF 再量高
    },
    insertToken(t) {
      const el = editorRef.current; if (!el) return;
      el.focus();
      insertTokenAtCaret(el, t);
      syncEmpty(); requestAnimationFrame(autoResize);
    },
    extract() {
      const el = editorRef.current;
      return el ? extractContent(el) : { plainText: '', tokens: [] };
    },
    setContent(parts) {
      const el = editorRef.current; if (!el) return;
      setEditorContent(el, parts);
      syncEmpty(); requestAnimationFrame(autoResize);
    },
    clear() {
      const el = editorRef.current; if (!el) return;
      el.textContent = '';
      syncEmpty(); autoResize();
    },
    focus() { editorRef.current?.focus(); },
    isEmpty() { const el = editorRef.current; return el ? isEditorEmpty(el) : true; },
    getAtTrigger() { const el = editorRef.current; return el ? detectAtTrigger(el) : null; },
    getElement() { return editorRef.current; },
  }), [syncEmpty, autoResize]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return; // IME 守卫（P1/P2/P20 前置）
    // 父先处理（菜单导航 / Ctrl+Enter 发送 / Esc）。
    if (onEditorKeyDown && onEditorKeyDown(e)) return;
    if (e.defaultPrevented) return;
    // 两段式退格删 atomic token（P7）。
    if (e.key === 'Backspace') {
      const sel = window.getSelection();
      const el = editorRef.current;
      if (sel && el) {
        const token = findAtomicTokenBeforeCaret(sel, el);
        if (token) {
          e.preventDefault();
          removeTokenSpan(token);
          handleInput();
          return;
        }
      }
    }
    // Enter（非 Ctrl/Meta/Shift，菜单未消费）→ 统一插换行（P11，避 Chromium 默认 <div> 分块）。
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      document.execCommand('insertLineBreak');
      handleInput();
    }
  }, [onEditorKeyDown, handleInput]);

  const handlePaste = useCallback((e: ClipboardEvent<HTMLDivElement>) => {
    const dt = e.clipboardData;
    // 图片优先走父附件链路（P16）。
    const imageFiles: File[] = [];
    for (const item of Array.from(dt.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) imageFiles.push(f);
      }
    }
    if (imageFiles.length && onPasteFiles) {
      e.preventDefault();
      onPasteFiles(imageFiles);
      return;
    }
    // 纯文本（杜绝富文本 / HTML 注入，P4）。MEDIUM-3：按行显式插入，换行走 insertLineBreak（与 Enter / setEditorContent
    // 的 <br> 口径统一，避免 Chromium insertText 对 \n 插 <div> 块导致提取换行错位）。
    e.preventDefault();
    const text = dt.getData('text/plain');
    if (text) {
      const lines = text.split(/\r\n|\r|\n/);
      lines.forEach((line, i) => {
        if (i > 0) document.execCommand('insertLineBreak');
        if (line) document.execCommand('insertText', false, line);
      });
    }
    handleInput();
  }, [onPasteFiles, handleInput]);

  return (
    <div
      ref={editorRef}
      className={`rich-input${className ? ' ' + className : ''}`}
      contentEditable={!disabled}
      role="textbox"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      aria-multiline="true"
      data-empty="true"
      data-placeholder={placeholder}
      spellCheck={false}
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onCompositionStart={() => {
        isComposingRef.current = true;
        // ★ M7 #3：IME 组合输入期间隐藏 placeholder——此时 contenteditable 已显示拼音/候选字符，
        //   但 input 事件被 isComposing 守卫跳过、data-empty 仍是 true，placeholder 会和拼音字符重叠。
        if (editorRef.current) editorRef.current.dataset.empty = 'false';
      }}
      onCompositionEnd={() => {
        isComposingRef.current = false;
        editorRef.current?.normalize(); // P1：合并 IME 拆开的相邻文本节点，再触发检测
        queueMicrotask(() => handleInput()); // P2：延后，避开 insertCompositionText 的重复 input
      }}
    />
  );
}

export const RichTextInput = memo(forwardRef<RichTextInputHandle, Props>(RichTextInputInner));
