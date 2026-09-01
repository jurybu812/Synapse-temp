const http = require('node:http');

const port = Number(process.env.SYNAPSE_BPC_MOCK_PORT || 54862);
let requestCount = 0;
let recordRequestCount = 0;
let titleRequestCount = 0;
let lastRecordPrompt = '';
let lastTitlePrompt = '';
const recordDelayMs = Math.max(0, Number(process.env.SYNAPSE_MOCK_RECORD_DELAY_MS || 0));
const mainPromptTokens = Math.max(0, Number(process.env.SYNAPSE_MOCK_MAIN_PROMPT_TOKENS || 23_000));

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  response.end(payload);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n');
}

function sendCompletion(response, requestBody, completion) {
  if (!requestBody?.stream) {
    sendJson(response, 200, completion);
    return;
  }
  const choice = completion.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const delta = { role: message.role || 'assistant' };
  if (typeof message.content === 'string') delta.content = message.content;
  if (Array.isArray(message.tool_calls)) {
    delta.tool_calls = message.tool_calls.map((toolCall, index) => ({
      index,
      id: toolCall.id,
      type: toolCall.type,
      function: toolCall.function,
    }));
  }
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
  });
  response.write(`data: ${JSON.stringify({
    id: completion.id,
    object: 'chat.completion.chunk',
    created: completion.created,
    model: completion.model,
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: completion.id,
    object: 'chat.completion.chunk',
    created: completion.created,
    model: completion.model,
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || 'stop' }],
    usage: completion.usage,
  })}\n\n`);
  response.end('data: [DONE]\n\n');
}

const validRecord = `# 对话过程日志

## 用户意图
- 检查真实工作区中的多文件故障并形成可验证修复

## 关键决策
- 保留完整对话轮，按对话隔离后台压缩候选
- 先验证持久状态，再发布正式 Record

## 工具调用与结果摘要
- 读取多个文件并运行构建，定位到状态归属和发布边界

## 产出文件清单
- src/example.ts：修复状态归属并补充回归验证`;

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    });
    response.end();
    return;
  }
  if (request.method === 'GET' && request.url === '/__state') {
    sendJson(response, 200, {
      requestCount,
      recordRequestCount,
      titleRequestCount,
      lastRecordContainsToolCall: lastRecordPrompt.includes('〔工具调用〕'),
      lastRecordContainsCommandResult: lastRecordPrompt.includes('RELATIVE_CWD_RESULT'),
      lastRecordExcerpt: lastRecordPrompt.slice(-2_000),
      lastTitleExcerpt: lastTitlePrompt.slice(-500),
    });
    return;
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    sendJson(response, 200, {
      object: 'list',
      data: [{ id: 'synapse-bpc-mock', object: 'model', owned_by: 'synapse-test', context_window: 32000 }],
    });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    sendJson(response, 404, { error: { message: 'not found' } });
    return;
  }
  try {
    const body = await readBody(request);
    requestCount += 1;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const prompt = JSON.stringify(messages);
    const latestUserIndex = messages.findLastIndex(message => message?.role === 'user');
    const latestUserContent = latestUserIndex >= 0 ? messageText(messages[latestUserIndex]?.content) : '';
    const isTitle = messages.some(message => messageText(message?.content).includes('对话标题助手'));
    const isRecord = !isTitle && latestUserContent.includes('技术过程记录助手');
    if (isRecord) {
      recordRequestCount += 1;
      lastRecordPrompt = prompt;
    }
    const failCompaction = isRecord && prompt.includes('[[FAIL_COMPACT]]');
    if (isTitle) {
      titleRequestCount += 1;
      lastTitlePrompt = prompt;
    }
    const loopLimit = !isRecord && latestUserContent.includes('[[LOOP_LIMIT]]');
    const relativeCwd = !isRecord && latestUserContent.includes('[[RELATIVE_CWD]]');
    const toolMessages = messages
      .slice(latestUserIndex + 1)
      .filter(message => message?.role === 'tool');
    if (loopLimit) {
      sendCompletion(response, body, {
        id: `mock-${requestCount}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model || 'synapse-bpc-mock',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: `正在执行第 ${toolMessages.length + 1} 次目录核对。`,
            tool_calls: [{
              id: `loop-${requestCount}`,
              type: 'function',
              function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 2_000 + toolMessages.length * 40, completion_tokens: 60, total_tokens: 2_060 + toolMessages.length * 40 },
      });
      return;
    }
    if (relativeCwd && toolMessages.length === 0) {
      sendCompletion(response, body, {
        id: `mock-${requestCount}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model || 'synapse-bpc-mock',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '我会在显式 cwd=. 下读取真实工作目录。',
            tool_calls: [{
              id: `cwd-${requestCount}`,
              type: 'function',
              function: {
                name: 'run_command',
                arguments: JSON.stringify({ command: 'node -e "console.log(\'RELATIVE_CWD_RESULT=\'+process.cwd())"', cwd: '.' }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 2_200, completion_tokens: 80, total_tokens: 2_280 },
      });
      return;
    }
    if (isRecord && recordDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, recordDelayMs));
    }
    const content = failCompaction
      ? '故障注入：故意返回不符合 Record 模板的内容'
      : isRecord
        ? validRecord
        : isTitle
          ? '多文件运行故障排查'
          : relativeCwd
            ? `相对目录检查完成。工具回包：${String(toolMessages.at(-1)?.content ?? '').slice(0, 600)}`
          : `已完成第 ${requestCount} 次拟真任务处理：检查工作区状态、分析多文件调用链、给出修改与验证步骤，并保留后续可继续追问的上下文。`;
    sendCompletion(response, body, {
      id: `mock-${requestCount}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'synapse-bpc-mock',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: isRecord ? 1200 : mainPromptTokens,
        completion_tokens: isRecord ? 300 : 120,
        total_tokens: isRecord ? 1500 : mainPromptTokens + 120,
      },
    });
  } catch (error) {
    sendJson(response, 400, { error: { message: String(error?.message || error) } });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`synapse-bpc-mock listening on 127.0.0.1:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
