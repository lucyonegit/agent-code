/**
 * ToolRegistry - 工具注册中心
 *
 * 提供集中化的方式来注册、检索和管理 ReAct agent 使用的工具。
 * 工具可以动态注入，并可转换为 LangChain 的 StructuredTool 格式。
 */

import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { Tool } from '../types/index.js';

/**
 * 从我们的 Tool 接口创建 LangChain StructuredTool
 */
function createLangChainTool(tool: Tool): StructuredTool {
  // 创建一个继承 StructuredTool 的动态类

  return new (class extends StructuredTool {
    name = tool.name;
    description = tool.description;
    schema = tool.parameters;

    async _call(args: z.infer<typeof tool.parameters>): Promise<string> {
      const result = await tool.execute(args);
      return result;
    }
  })();
}

/**
 * ToolRegistry - 管理工具的注册和检索
 *
 * @example
 * ```typescript
 * const registry = new ToolRegistry();
 *
 * registry.register({
 *   name: 'calculator',
 *   description: '执行基本算术运算',
 *   parameters: z.object({ expression: z.string() }),
 *   execute: async (args) => eval(args.expression).toString()
 * });
 *
 * const tools = registry.toLangChainTools();
 * ```
 */
export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  /**
   * 注册新工具
   * @param tool - 要注册的工具
   * @throws 如果同名工具已存在则抛出错误
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具 "${tool.name}" 已经注册`);
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * 批量注册多个工具
   * @param tools - 要注册的工具数组
   */
  registerAll(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * 按名称获取工具
   * @param name - 要检索的工具名称
   * @returns 找到则返回工具，否则返回 undefined
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * 获取所有已注册的工具
   * @returns 所有已注册工具的数组
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 按名称列表获取工具
   * @param names - 要检索的工具名称数组
   * @returns 匹配的工具数组
   */
  getByNames(names: string[]): Tool[] {
    return names
      .map(name => this.tools.get(name))
      .filter((tool): tool is Tool => tool !== undefined);
  }

  /**
   * 检查工具是否已注册
   * @param name - 要检查的工具名称
   * @returns 如果工具存在返回 true
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 从注册中心移除工具
   * @param name - 要移除的工具名称
   * @returns 如果工具被移除返回 true
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * 清空所有已注册的工具
   */
  clear(): void {
    this.tools.clear();
  }

  /**
   * 获取已注册工具的数量
   */
  get size(): number {
    return this.tools.size;
  }

  /**
   * 将所有已注册工具转换为 LangChain StructuredTool 格式
   * @returns LangChain StructuredTools 数组
   */
  toLangChainTools(): StructuredTool[] {
    return this.getAll().map(createLangChainTool);
  }

  /**
   * 将指定工具转换为 LangChain 格式
   * @param names - 要转换的工具名称
   * @returns LangChain StructuredTools 数组
   */
  toLangChainToolsByNames(names: string[]): StructuredTool[] {
    return this.getByNames(names).map(createLangChainTool);
  }

  /**
   * 获取格式化的工具描述（用于提示词）
   * @returns 描述所有工具的格式化字符串
   */
  getToolDescriptions(): string {
    const descriptions = this.getAll().map(tool => {
      const schemaStr = JSON.stringify(tool.parameters.shape, null, 2);
      return `- ${tool.name}: ${tool.description}\n  参数: ${schemaStr}`;
    });
    return descriptions.join('\n\n');
  }
}

/**
 * 将我们的 Tool 接口转换为 LangChain 工具的工具函数
 * 当需要转换单个工具而不使用注册中心时很有用
 */
export function toolToLangChain(tool: Tool): StructuredTool {
  return createLangChainTool(tool);
}

/**
 * 将多个工具转换为 LangChain 格式的工具函数
 */
export function toolsToLangChain(tools: Tool[]): StructuredTool[] {
  return tools.map(createLangChainTool);
}
