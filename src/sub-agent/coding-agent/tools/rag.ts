/**
 * RAG 查询工具
 * 查询内部组件库文档
 */

import { z } from 'zod';
import type { Tool } from '../../../types/index';

// RAG查询响应的类型定义
export interface RagQueryResponse {
  answer: string;
  sources: Array<{
    content: string;
    metadata: Record<string, any>;
  }>;
  formatted: string;
}

interface ErrorResponse {
  error?: string;
}

/**
 * 搜索组件文档
 */
export async function searchComponentDocs(
  query: string,
  componentName?: string,
  section?: 'API / Props' | 'Usage Example' | 'Description',
  limit = 5
): Promise<RagQueryResponse> {
  const requestBody = {
    query,
    metadataFilters: {
      component_name: componentName,
      section,
    },
    limit,
  };

  try {
    const response = await fetch('http://192.168.21.101:3000/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as ErrorResponse;
      throw new Error(`${response.status} ${response.statusText}${errorData.error ? ` - ${errorData.error}` : ''}`);
    }

    const data = await response.json() as { answer: string; sources: RagQueryResponse['sources'] };
    return {
      answer: data.answer,
      sources: data.sources,
      formatted: `查询: ${query}${componentName ? ` (组件: ${componentName})` : ''}${section ? ` [${section}]` : ''}\n回答: ${data.answer}\n来源数量: ${data.sources?.length || 0}`
    };
  } catch (error) {
    const errorMsg = `查询失败: ${error instanceof Error ? error.message : '未知错误'}`;
    return {
      answer: errorMsg,
      sources: [],
      formatted: errorMsg
    };
  }
}

/**
 * 获取组件列表
 */
export async function getComponentList(): Promise<RagQueryResponse> {
  try {
    const response = await fetch('http://192.168.21.101:3000/getComponentList', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as ErrorResponse;
      throw new Error(`${response.status} ${response.statusText}${errorData.error ? ` - ${errorData.error}` : ''}`);
    }

    const data = await response.json() as { answer: string; sources: RagQueryResponse['sources'] };
    return {
      answer: data.answer,
      sources: data.sources,
      formatted: `查询: 所有可用组件列表\n回答: ${data.answer}\n来源数量: ${data.sources?.length || 0}`
    };
  } catch (error) {
    const errorMsg = `获取失败: ${error instanceof Error ? error.message : '未知错误'}`;
    return {
      answer: errorMsg,
      sources: [],
      formatted: errorMsg
    };
  }
}

/**
 * 创建 RAG 组件查询工具（用于 LLM 工具调用）
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
      const result = await searchComponentDocs(args.query, args.component_name, args.section, args.limit || 5);
      return JSON.stringify(result, null, 2);
    },
  };
}

/**
 * 创建获取组件列表工具（用于 LLM 工具调用）
 */
export function createGetComponentListTool(): Tool {
  return {
    name: 'get_component_list',
    description: '获取所有可用的内部组件列表',
    parameters: z.object({}),
    execute: async () => {
      const result = await getComponentList();
      return JSON.stringify(result, null, 2);
    },
  };
}


