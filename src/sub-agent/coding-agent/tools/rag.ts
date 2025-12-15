/**
 * RAG 查询工具
 * 查询内部组件库文档
 */

import { z } from 'zod';
import type { Tool } from '../../../types/index';

// RAG查询输入的Zod schema
const RagQueryInputSchema = z.object({
  query: z.string().describe('RAG查询字符串'),
  metadataFilters: z.object({
    component_name: z.string().optional(),
    section: z.enum(['API / Props', 'Usage Example', 'Description']).optional()
  }).optional().describe('元数据过滤器'),
  limit: z.number().optional().default(5).describe('返回结果的最大数量')
});

// RAG查询响应的类型定义
interface RagQueryResponse {
  answer: string;
  sources: Array<{
    content: string;
    metadata: Record<string, any>;
  }>;
}

interface ErrorResponse {
  error?: string;
}

/**
 * RAG 查询实现
 */
async function executeRagQuery(input: any): Promise<any> {
  const { query, metadataFilters, limit = 5 } = RagQueryInputSchema.parse(input);

  const requestBody = { query, metadataFilters, limit };

  const response = await fetch('http://192.168.21.101:3000/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({})) as ErrorResponse;
    throw new Error(`RAG查询失败: ${response.status} ${response.statusText}${errorData.error ? ` - ${errorData.error}` : ''}`);
  }

  const data = await response.json() as RagQueryResponse;

  return {
    result: data.answer,
    sources: data.sources,
    formatted: `查询: ${query}\n回答: ${data.answer}\n来源数量: ${data.sources?.length || 0}`
  };
}

/**
 * 获取组件列表实现
 */
async function executeGetComponentList(): Promise<any> {
  const response = await fetch('http://192.168.21.101:3000/getComponentList', {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({})) as ErrorResponse;
    throw new Error(`RAG查询失败: ${response.status} ${response.statusText}${errorData.error ? ` - ${errorData.error}` : ''}`);
  }

  const data = await response.json() as RagQueryResponse;

  return {
    result: data.answer,
    sources: data.sources,
    formatted: `查询: 所有可用组件列表\n回答: ${data.answer}\n来源数量: ${data.sources?.length || 0}`
  };
}

/**
 * 创建 RAG 组件查询工具
 */
export function createRagSearchTool(): Tool {
  return {
    name: 'search_component_docs',
    description: '搜索内部组件库文档，获取组件 API 和使用示例',
    parameters: z.object({
      query: z.string().describe('搜索关键字'),
      component_name: z.string().optional().describe('组件名称'),
      section: z.enum(['API / Props', 'Usage Example', 'Description']).optional().describe('文档章节'),
      limit: z.number().optional().describe('返回结果数量'),
    }),
    execute: async (args) => {
      try {
        const result = await executeRagQuery({
          query: args.query,
          metadataFilters: {
            component_name: args.component_name,
            section: args.section,
          },
          limit: args.limit || 5,
        });
        return JSON.stringify(result, null, 2);
      } catch (error) {
        return `RAG 查询失败: ${error instanceof Error ? error.message : '未知错误'}`;
      }
    },
  };
}

/**
 * 创建获取组件列表工具
 */
export function createGetComponentListTool(): Tool {
  return {
    name: 'get_component_list',
    description: '获取所有可用的内部组件列表',
    parameters: z.object({}),
    execute: async () => {
      try {
        const result = await executeGetComponentList();
        return JSON.stringify(result, null, 2);
      } catch (error) {
        return `获取组件列表失败: ${error instanceof Error ? error.message : '未知错误'}`;
      }
    },
  };
}

// 兼容旧接口（用于原始 ToolDefinition 格式）
export const RagQueryTool = {
  name: 'search_component_docs',
  description: '用于模糊搜索组件',
  parameters: [],
  execute: executeRagQuery
};

export const RagQueryAvailableComponents = {
  name: 'get_component_list',
  description: '获取所有可用组件名列表',
  parameters: [],
  execute: executeGetComponentList
};
