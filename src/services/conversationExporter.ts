/**
 * Conversation Exporter
 * 支持 Markdown / JSON / 纯文本 导出
 */

interface ExportMessage {
  role: string;
  content: string;
  timestamp?: number;
  toolCalls?: any[];
}

type ExportFormat = 'markdown' | 'json' | 'text';

class ConversationExporter {
  export(messages: ExportMessage[], format: ExportFormat = 'markdown') {
    const content = this.formatContent(messages, format);
    const ext = format === 'json' ? 'json' : format === 'markdown' ? 'md' : 'txt';
    const mimeType = format === 'json' ? 'application/json' : 'text/plain';
    this.downloadFile(content, `synapse-conversation-${Date.now()}.${ext}`, mimeType);
  }

  formatContent(messages: ExportMessage[], format: ExportFormat): string {
    switch (format) {
      case 'json':
        return JSON.stringify({
          exportedAt: new Date().toISOString(),
          platform: 'Synapse',
          messageCount: messages.length,
          messages: messages.map(m => ({
            role: m.role,
            content: m.content,
            timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : undefined,
            toolCalls: m.toolCalls,
          })),
        }, null, 2);

      case 'text':
        return messages.map(m => {
          const role = m.role === 'user' ? '你' : m.role === 'assistant' ? 'AI' : m.role;
          const time = m.timestamp ? ` (${new Date(m.timestamp).toLocaleString()})` : '';
          return `[${role}${time}]\n${m.content}\n`;
        }).join('\n---\n\n');

      case 'markdown':
      default:
        return this.formatMarkdown(messages);
    }
  }

  private formatMarkdown(messages: ExportMessage[]): string {
    const header = `# Synapse 对话记录\n\n> 导出时间: ${new Date().toLocaleString()}\n> 消息数量: ${messages.length}\n\n---\n\n`;

    const body = messages.map(m => {
      const role = m.role === 'user' ? '👤 用户' : m.role === 'assistant' ? '🤖 AI' : `🔧 ${m.role}`;
      const time = m.timestamp ? `*${new Date(m.timestamp).toLocaleTimeString()}*` : '';
      let text = `### ${role} ${time}\n\n${m.content}\n`;

      if (m.toolCalls?.length) {
        text += '\n**工具调用:**\n';
        for (const tc of m.toolCalls) {
          text += `- \`${tc.name}\``;
          if (tc.args) text += `: \`${JSON.stringify(tc.args).slice(0, 100)}\``;
          text += '\n';
        }
      }

      return text;
    }).join('\n---\n\n');

    return header + body;
  }

  private downloadFile(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
}

export const conversationExporter = new ConversationExporter();
