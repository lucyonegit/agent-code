/**
 * SSE Server - 通过 Server-Sent Events 暴露 ReActExecutor 和 PlannerExecutor 接口
 * 
 * 使用方法：
 * 1. 启动服务器: npx tsx src/server/index.ts
 * 2. 发送请求: POST /api/react 或 POST /api/planner
 *    Body: { "input": "你的问题", "tools": ["tool1", "tool2"] }
 * 3. 接收 SSE 流式响应
 */

import http from 'http';
import { ReActExecutor } from '../core/ReActExecutor.js';
import { PlannerExecutor } from '../core/PlannerExecutor.js';
import { type Tool, type ReActEvent, type Plan } from '../types/index.js';
import { z } from 'zod';

// ============================================================================
// 配置
// ============================================================================

const PORT = 3000;
const API_KEY = 'sk-2da524e57ee64485ab4208430ab35f4d';

// ============================================================================
// 预定义工具（示例）
// ============================================================================

const AVAILABLE_TOOLS: Record<string, Tool> = {
  get_weather: {
    name: 'get_weather',
    description: '获取指定位置的当前天气信息',
    parameters: z.object({
      location: z.string().describe('要获取天气的城市或位置'),
      unit: z.enum(['celsius', 'fahrenheit']).nullable().optional().describe('温度单位'),
    }),
    execute: async (args) => {
      // 模拟天气 API
      return JSON.stringify({
        location: args.location,
        temperature: 25,
        unit: args.unit || 'celsius',
        condition: '晴天',
        humidity: 60,
      });
    },
  },
  calculator: {
    name: 'calculator',
    description: '执行数学计算',
    parameters: z.object({
      expression: z.string().describe('数学表达式'),
    }),
    execute: async (args) => {
      try {
        const sanitized = args.expression.replace(/[^0-9+\-*/().%\s]/g, '');
        const result = Function(`"use strict"; return (${sanitized})`)();
        return `${args.expression} = ${result}`;
      } catch {
        return `计算错误: ${args.expression}`;
      }
    },
  },
  web_search: {
    name: 'web_search',
    description: '搜索网络信息',
    parameters: z.object({
      query: z.string().describe('搜索关键词'),
    }),
    execute: async (args) => {
      // 模拟搜索 API
      return JSON.stringify([
        { title: `"${args.query}" 的搜索结果`, snippet: '这是一个示例搜索结果...' },
      ]);
    },
  },
};

// ============================================================================
// SSE 辅助函数
// ============================================================================

/**
 * 发送 SSE 事件
 */
function sendSSE(res: http.ServerResponse, event: string, data: any): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * 设置 SSE 响应头
 */
function setSSEHeaders(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
}

// ============================================================================
// 请求处理
// ============================================================================

/**
 * 解析请求体
 */
async function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 处理 ReAct 请求
 */
async function handleReactRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  // 设置 SSE 头
  setSSEHeaders(res);

  try {
    // 解析请求体
    const body = await parseBody(req);
    const { input, tools: toolNames = ['get_weather', 'calculator', 'web_search'] } = body;

    if (!input) {
      sendSSE(res, 'error', { message: '缺少 input 参数' });
      res.end();
      return;
    }

    // 获取请求的工具
    const tools: Tool[] = toolNames
      .filter((name: string) => AVAILABLE_TOOLS[name])
      .map((name: string) => AVAILABLE_TOOLS[name]);

    if (tools.length === 0) {
      sendSSE(res, 'error', { message: '没有可用的工具' });
      res.end();
      return;
    }

    // 创建 ReActExecutor
    const executor = new ReActExecutor({
      model: 'qwen-max',
      provider: 'tongyi',
      streaming: true,
      maxIterations: 10,
      apiKey: API_KEY,
    });

    // 执行并流式返回结果
    const result = await executor.run({
      input,
      tools,
      onMessage: (event: ReActEvent) => {
        sendSSE(res, event.type, event);
      },
    });

    // 发送完成事件
    sendSSE(res, 'done', { result });
    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    sendSSE(res, 'error', { message });
    res.end();
  }
}

/**
 * 处理 Planner 请求
 */
async function handlePlannerRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  // 设置 SSE 头
  setSSEHeaders(res);

  try {
    // 解析请求体
    const body = await parseBody(req);
    const { goal, tools: toolNames = ['get_weather', 'calculator', 'web_search'] } = body;

    if (!goal) {
      sendSSE(res, 'error', { message: '缺少 goal 参数' });
      res.end();
      return;
    }

    // 获取请求的工具
    const tools: Tool[] = toolNames
      .filter((name: string) => AVAILABLE_TOOLS[name])
      .map((name: string) => AVAILABLE_TOOLS[name]);

    if (tools.length === 0) {
      sendSSE(res, 'error', { message: '没有可用的工具' });
      res.end();
      return;
    }

    // 创建 PlannerExecutor
    const planner = new PlannerExecutor({
      plannerModel: 'qwen-max',
      executorModel: 'qwen-max',
      provider: 'tongyi',
      maxIterationsPerStep: 10,
      maxRePlanAttempts: 3,
      apiKey: API_KEY,
    });

    // 执行并流式返回结果
    const result = await planner.run({
      goal,
      tools,
      onMessage: (event: ReActEvent) => {
        sendSSE(res, event.type, event);
      },
      onPlanUpdate: (plan: Plan) => {
        sendSSE(res, 'plan_update', { type: 'plan_update', plan });
      },
    });

    // 发送完成事件
    sendSSE(res, 'planner_done', { 
      type: 'planner_done',
      success: result.success,
      response: result.response,
      plan: result.plan,
    });
    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    sendSSE(res, 'error', { message });
    res.end();
  }
}

// ============================================================================
// 服务器创建
// ============================================================================

const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  // CORS 预检请求
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // 健康检查
  if (method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // 获取可用工具列表
  if (method === 'GET' && url === '/api/tools') {
    res.writeHead(200, { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({
      tools: Object.keys(AVAILABLE_TOOLS).map(name => ({
        name,
        description: AVAILABLE_TOOLS[name].description,
      })),
    }));
    return;
  }

  // ReAct 接口
  if (method === 'POST' && url === '/api/react') {
    await handleReactRequest(req, res);
    return;
  }

  // Planner 接口
  if (method === 'POST' && url === '/api/planner') {
    await handlePlannerRequest(req, res);
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

// 启动服务器
server.listen(PORT, () => {
  console.log(`🚀 Agent SSE Server running at http://localhost:${PORT}`);
  console.log('');
  console.log('可用接口:');
  console.log(`  GET  http://localhost:${PORT}/health       - 健康检查`);
  console.log(`  GET  http://localhost:${PORT}/api/tools    - 获取可用工具`);
  console.log(`  POST http://localhost:${PORT}/api/react    - ReAct 执行 (SSE)`);
  console.log(`  POST http://localhost:${PORT}/api/planner  - Planner 执行 (SSE)`);
  console.log('');
  console.log('示例请求:');
  console.log(`  curl -X POST http://localhost:${PORT}/api/planner \\`);
  console.log('    -H "Content-Type: application/json" \\');
  console.log('    -d \'{"goal": "查询北京和上海的天气并比较"}\'');
});
