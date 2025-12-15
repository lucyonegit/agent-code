import { z } from 'zod';
import { ToolDefinition } from '../../types/index.js';

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
 * RAG组件详情查询
 */
export const RagQueryTool: ToolDefinition = {
  name: 'search_component_docs',
  description: '用于模糊搜索组件',
  parameters: [
    {
      name: 'query',
      type: 'string',
      description: '搜索关键字。例如 "下拉框", "日历", "UserSelect"',
      required: true,
      schema: z.string()
    },
    {
      name: 'metadataFilters',
      type: 'object',
      description: '用于过滤元数据的条件，例如 {"component_name": "UserSelect", "section": "API / Props"}, section 可选值为 "API / Props", "Usage Example", "Description"',
      required: false,
      schema: z.object({
        component_name: z.string().optional(),
        section: z.enum(['API / Props', 'Usage Example', 'Description']).optional()
      })
    },
    {
      name: 'limit',
      type: 'number',
      description: '返回结果的最大数量，默认为3',
      required: false,
      schema: z.number().optional()
    }
  ],
  execute: async (input: any) => {
    try {
      const { query, metadataFilters, limit = 5 } = RagQueryInputSchema.parse(input);

      // 构建请求体
      const requestBody = {
        query,
        metadataFilters,
        limit
      };

      // 调用RAG查询接口
      const response = await fetch('http://192.168.21.101:3000/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
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
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`RAG查询执行失败: ${error.message}`);
      }
      throw new Error('RAG查询执行失败: 未知错误');
    }
  }
};


export const RagQueryAvailableComponents: ToolDefinition = {
  name: 'get_component_list',
  description: '获取所有可用组件名列表',
  parameters: [],
  execute: async (input: any) => {
    try {
      // 调用RAG查询接口
      const response = await fetch('http://192.168.21.101:3000/getComponentList', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        }
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
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`RAG查询执行失败: ${error.message}`);
      }
      throw new Error('RAG查询执行失败: 未知错误');
    }
  }
};

