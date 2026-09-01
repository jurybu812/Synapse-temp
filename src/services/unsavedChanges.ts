import type { EditorTab } from '@/store/slices/editorTabs';
import { chooseAction, showNotice } from '@/services/confirmationCoordinator';
import { saveEditorFileWithConflictProtection } from '@/services/editorFileSave';

export type UnsavedChoice = 'save' | 'discard' | 'cancel';

async function promptUnsavedChoice(tab: EditorTab, actionLabel: string): Promise<UnsavedChoice> {
  const answer = await chooseAction({
    title: '文件有未保存修改',
    message: `「${tab.fileName}」尚未保存。请选择${actionLabel}前的处理方式。`,
    cancelLabel: '取消操作',
    choices: [
      { value: 'save', label: '保存并继续' },
      { value: 'discard', label: '放弃修改', tone: 'danger' },
    ],
  });
  return answer === 'save' || answer === 'discard' ? answer : 'cancel';
}

export async function resolveUnsavedTabs(
  tabs: EditorTab[],
  actionLabel = '继续操作',
): Promise<boolean> {
  const dirtyTabs = tabs.filter(tab => tab.isDirty);
  for (const tab of dirtyTabs) {
    const choice = await promptUnsavedChoice(tab, actionLabel);
    if (choice === 'cancel') return false;
    if (choice === 'save') {
      if (!tab.filePath || tab.content === undefined) {
        await showNotice({
          title: '无法保存文件',
          message: `「${tab.fileName}」缺少可保存的文件内容。`,
          tone: 'danger',
        });
        return false;
      }
      try {
        await saveEditorFileWithConflictProtection(
          tab.filePath,
          tab.fileName,
          tab.content,
          tab.savedContent,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : '未知错误';
        await showNotice({
          title: '保存文件失败',
          message: `「${tab.fileName}」保存失败：${message}`,
          tone: 'danger',
        });
        return false;
      }
    }
  }
  return true;
}
