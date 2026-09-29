/**
 * 会话持久化存储层。
 *
 * 将会话以 JSON 形式写入磁盘（<dataDir>/sessions/<id>.json），并支持加载时
 * 的结构校验。数据目录通过构造注入，便于在测试中隔离真实文件系统。
 */

import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Conversation, ChatMessage, MessageRole } from '../models/message.js';
import { SessionLoadError } from '../errors.js';

/** 会话存储的抽象接口，便于测试替换为内存实现。 */
export interface SessionStore {
  saveSession(conversation: Conversation): Promise<void>;
  loadSession(id: string): Promise<Conversation>;
  listSessions(): Promise<string[]>;
  /** 列出所有已保存的完整会话（按需实现，默认基于 listSessions + loadSession）。 */
  listConversations(): Promise<Conversation[]>;
  /** 删除指定 id 的会话。会话不存在时应抛出 SessionLoadError。 */
  deleteSession(id: string): Promise<void>;
  /** 删除所有已保存的会话。返回实际删除的数量。 */
  deleteAllSessions(): Promise<number>;
}

/** 合法的消息角色集合，用于结构校验。 */
const VALID_ROLES: readonly MessageRole[] = ['system', 'user', 'assistant', 'tool'];

/**
 * 判断一个未知值是否为合法消息列表。
 * 校验每条消息的 role 是否在合法集合内，以及 content 是否为字符串。
 */
function isMessageArray(value: unknown): value is ChatMessage[] {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      VALID_ROLES.includes((item as ChatMessage).role) &&
      typeof (item as ChatMessage).content === 'string',
  );
}

/**
 * 判断一个未知值是否为结构合法的会话对象。
 * 校验 id 为字符串、createdAt 为字符串（可选）、messages 为合法消息数组。
 */
function isConversation(value: unknown): value is Conversation {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.createdAt === 'string' &&
    isMessageArray(record.messages)
  );
}

/** 校验失败时抛出的会话加载错误。 */
function invalidSession(id: string, detail: string): SessionLoadError {
  return new SessionLoadError(`无法加载会话 "${id}"：${detail}`);
}

/**
 * 基于文件系统的会话存储实现。
 * @param dataDir 存储根目录，会话会写入其下的 sessions 子目录。
 */
export class FileSessionStore implements SessionStore {
  private readonly sessionsDir: string;

  constructor(dataDir: string) {
    this.sessionsDir = join(dataDir, 'sessions');
  }

  /** 将会话写入 <dataDir>/sessions/<id>.json。 */
  async saveSession(conversation: Conversation): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    const filePath = join(this.sessionsDir, `${conversation.id}.json`);
    await writeFile(filePath, JSON.stringify(conversation, null, 2), 'utf8');
  }

  /**
   * 加载指定 id 的会话。
   * 当文件不存在、JSON 无效或结构校验失败时抛出 SessionLoadError。
   */
  async loadSession(id: string): Promise<Conversation> {
    const filePath = join(this.sessionsDir, `${id}.json`);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw invalidSession(id, '会话不存在');
      }
      throw invalidSession(id, `读取文件失败：${String(error)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalidSession(id, '存储数据不是合法 JSON');
    }

    if (!isConversation(parsed)) {
      throw invalidSession(id, '存储数据结构不合法');
    }
    return parsed;
  }

  /** 列出所有已保存会话的 id。 */
  async listSessions(): Promise<string[]> {
    let files: string[];
    try {
      files = await readdir(this.sessionsDir);
    } catch {
      // 目录尚不存在时视为没有会话，而非错误。
      return [];
    }
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  }

  /** 列出所有已保存的完整会话。 */
  async listConversations(): Promise<Conversation[]> {
    const ids = await this.listSessions();
    const convs: Conversation[] = [];
    for (const id of ids) {
      try {
        convs.push(await this.loadSession(id));
      } catch {
        // 跳过损坏的会话
      }
    }
    return convs;
  }

  /**
   * 删除指定 id 的会话文件。
   * 若文件不存在（ENOENT），抛出 SessionLoadError。
   */
  async deleteSession(id: string): Promise<void> {
    const filePath = join(this.sessionsDir, `${id}.json`);
    try {
      await unlink(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw invalidSession(id, '会话不存在');
      }
      throw invalidSession(id, `删除文件失败：${String(error)}`);
    }
  }

  /**
   * 删除所有已保存的会话。
   * 返回实际删除的数量。若目录不存在则返回 0。
   */
  async deleteAllSessions(): Promise<number> {
    const ids = await this.listSessions();
    let deleted = 0;
    for (const id of ids) {
      try {
        await this.deleteSession(id);
        deleted += 1;
      } catch {
        // 跳过删除失败的会话（如已被其他进程删除）
      }
    }
    return deleted;
  }
}
