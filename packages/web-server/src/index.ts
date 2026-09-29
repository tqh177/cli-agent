import Koa from 'koa';
import Router from '@koa/router';
import { bodyParser } from '@koa/bodyparser';
import { createReadStream } from 'node:fs';
import { join, extname } from 'node:path';
import { DefaultAgent, SessionStore, createConversation } from '@agent/core';
import type { Conversation } from '@agent/core';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export interface WebChatServerOptions {
  port: number;
  host: string;
  agent: DefaultAgent;
  store: SessionStore;
  systemPrompt?: string;
  staticDir: string;
}

export class WebChatServer {
  private app: Koa;
  private router: Router;
  private server: ReturnType<Koa['listen']> | null = null;
  private options: WebChatServerOptions;

  constructor(options: WebChatServerOptions) {
    this.options = options;
    this.app = new Koa();
    this.router = new Router();

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    const { staticDir } = this.options;

    // 静态文件服务 — 在 router 之前注册
    this.app.use(async (ctx, next) => {
      const path = ctx.path;
      if (path === '/' || path.startsWith('/api/')) {
        return next();
      }
      const ext = extname(path);
      if (ext && MIME_TYPES[ext]) {
        ctx.type = MIME_TYPES[ext];
        ctx.body = createReadStream(join(staticDir, path));
        return;
      }
      return next();
    });

    this.app.use(bodyParser({ enableTypes: ['json'], parsedMethods: ['POST', 'PUT', 'PATCH'] } as any));
    this.app.use(this.router.routes());
    this.app.use(this.router.allowedMethods());
  }

  private setupRoutes(): void {
    const { agent, store, systemPrompt, staticDir } = this.options;

    // 根路径 → index.html
    this.router.get('/', async (ctx) => {
      ctx.type = 'text/html; charset=utf-8';
      ctx.body = createReadStream(join(staticDir, 'index.html'));
    });

    // 会话列表
    this.router.get('/api/conversations', async (ctx) => {
      const convs = await store.listConversations();
      const items = convs
        .sort((a: Conversation, b: Conversation) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .map((c: Conversation) => ({
          id: c.id,
          createdAt: c.createdAt,
          // 消息计数按"轮次"统计：每个 user 消息视为一轮对话，
          // 工具调用与 assistant 回复归并到同一轮，不再单独计条。
          messageCount: c.messages.filter((m) => m.role === 'user').length,
          preview: c.messages.find((m) => m.role === 'user')?.content?.slice(0, 50) || '',
        }));
      ctx.body = items;
    });

    // 会话详情
    this.router.get('/api/conversations/:id', async (ctx) => {
      try {
        const conv = await store.loadSession(ctx.params.id);
        ctx.body = { id: conv.id, createdAt: conv.createdAt, messages: conv.messages };
      } catch {
        ctx.status = 404;
        ctx.body = { error: 'Conversation not found' };
      }
    });

    // 创建会话
    this.router.post('/api/conversations', async (ctx) => {
      const body = ctx.request.body as Record<string, unknown> | undefined;
      const prompt = typeof body?.systemPrompt === 'string' ? body.systemPrompt : systemPrompt;
      const conv = createConversation(prompt);
      await store.saveSession(conv);
      ctx.body = { id: conv.id, createdAt: conv.createdAt, messages: conv.messages };
    });

    // 发送消息（SSE）
    this.router.post('/api/conversations/:id/messages', async (ctx) => {
      const convId = ctx.params.id;
      const body = ctx.request.body as Record<string, unknown> | undefined;
      const content = typeof body?.content === 'string' ? body.content.trim() : '';
      const model = typeof body?.model === 'string' ? body.model : undefined;

      if (!content) {
        ctx.status = 400;
        ctx.body = { error: 'Message content is required' };
        return;
      }

      let conv: Conversation;
      try {
        conv = await store.loadSession(convId);
      } catch {
        ctx.status = 404;
        ctx.body = { error: 'Conversation not found' };
        return;
      }

      // 设置 SSE 响应头
      ctx.set('Content-Type', 'text/event-stream');
      ctx.set('Cache-Control', 'no-cache');
      ctx.set('Connection', 'keep-alive');
      ctx.respond = false; // 手动控制响应

      const res = ctx.res;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const sendEvent = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        agent.start(conv);

        // 设置工具回调
        agent.setToolCallback((params) => {
          // 服务端打印工具调用日志（Web 模式下命令行也可见）
          console.log(`\n🔧 工具调用: ${params.toolCall.function.name}`);
          console.log(`📝 参数: ${params.toolCall.function.arguments}`);
          const result = params.result;
          const displayResult = result.length > 200 ? result.substring(0, 200) + '...' : result;
          console.log(`✅ 结果: ${displayResult}\n`);

          sendEvent('tool_call', {
            type: 'tool_call',
            name: params.toolCall.function.name,
            arguments: params.toolCall.function.arguments,
          });
          sendEvent('tool_result', {
            type: 'tool_result',
            name: params.toolCall.function.name,
            result: params.result,
          });
        });

        // 流式回复
        for await (const chunk of agent.streamReply(conv, content, model)) {
          sendEvent('token', { type: 'token', token: chunk });
        }

        // 保存会话
        const updatedConv = agent.getConversation();
        if (updatedConv) {
          await store.saveSession(updatedConv);
        }

        sendEvent('done', { type: 'done', conversationId: convId });
      } catch (err) {
        sendEvent('error', {
          type: 'error',
          message: err instanceof Error ? err.message : 'Internal error',
        });
      }

      res.end();
    });

    // 删除所有会话
    this.router.delete('/api/conversations', async (ctx) => {
      const deleted = await store.deleteAllSessions();
      ctx.body = { deleted };
    });

    // 删除指定会话
    this.router.delete('/api/conversations/:id', async (ctx) => {
      try {
        await store.deleteSession(ctx.params.id);
        ctx.body = { success: true };
      } catch {
        ctx.status = 404;
        ctx.body = { error: 'Conversation not found' };
      }
    });

    // 删除会话中的指定消息（按索引）
    this.router.post('/api/conversations/:id/messages/delete', async (ctx) => {
      const convId = ctx.params.id;
      const body = ctx.request.body as Record<string, unknown> | undefined;
      const indices: number[] = Array.isArray(body?.indices) ? (body.indices as number[]) : [];

      if (indices.length === 0) {
        ctx.status = 400;
        ctx.body = { error: 'indices array is required' };
        return;
      }

      let conv: Conversation;
      try {
        conv = await store.loadSession(convId);
      } catch {
        ctx.status = 404;
        ctx.body = { error: 'Conversation not found' };
        return;
      }

      // 按索引降序排序，从后往前删除避免索引偏移
      const sorted = [...indices].sort((a, b) => b - a);
      for (const idx of sorted) {
        if (idx >= 0 && idx < conv.messages.length) {
          conv.messages.splice(idx, 1);
        }
      }

      await store.saveSession(conv);
      ctx.body = { success: true, messageCount: conv.messages.length };
    });

    // 模型列表
    this.router.get('/api/models', async (ctx) => {
      const pm = agent.getProviderManager();
      if (!pm) {
        ctx.body = { models: [] };
        return;
      }
      ctx.body = {
        models: pm.listModels(),
      };
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.options.port, this.options.host, () => {
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
