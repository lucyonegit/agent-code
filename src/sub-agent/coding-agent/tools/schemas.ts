/**
 * 共享的 Schema 定义
 * 确保 BDD、Architect、CodeGen 工具之间的数据传递一致性
 */

import { z } from 'zod';

/**
 * BDD 场景 Schema
 */
export const BDDScenarioSchema = z.object({
  id: z.string().describe('场景 ID'),
  title: z.string().describe('场景标题'),
  given: z.array(z.string()).describe('前置条件'),
  when: z.array(z.string()).describe('触发动作'),
  then: z.array(z.string()).describe('预期结果'),
});

/**
 * BDD Feature Schema
 */
export const BDDFeatureSchema = z.object({
  feature_id: z.string().describe('功能唯一标识'),
  feature_title: z.string().describe('功能标题'),
  description: z.string().describe('功能描述'),
  scenarios: z.array(BDDScenarioSchema).describe('场景列表'),
});

/**
 * BDD 结果数组 Schema（decompose_to_bdd 的输出）
 */
export const BDDResultSchema = z.array(BDDFeatureSchema);

/**
 * 架构文件依赖 Schema
 */
export const ArchitectureDependencySchema = z.object({
  path: z.string().describe('依赖文件路径，必须从 src 开始'),
  import: z.array(z.string()).describe('导入的成员名称'),
});

/**
 * 架构文件 Schema
 * 注意：某些字段设为可选以适应 LLM 的不确定输出
 */
export const ArchitectureFileSchema = z.object({
  path: z.string().describe('文件路径，必须从 src 开始'),
  type: z
    .enum(['component', 'page', 'hook', 'service', 'config', 'util', 'type', 'test', 'route'])
    .describe('文件类型'),
  description: z.string().describe('文件描述'),
  bdd_references: z.array(z.string()).describe('关联的 BDD 场景 ID'),
  status: z.string().optional().describe('状态'), // 放宽为可选字符串
  dependencies: z.array(ArchitectureDependencySchema).describe('依赖'),
  rag_context_used: z.any().optional(), // 放宽：可为 null 或任意值
  content: z.any().optional(), // 放宽：可为 null 或任意值
});

/**
 * 架构结果数组 Schema（design_architecture 的输出）
 */
export const ArchitectureResultSchema = z.array(ArchitectureFileSchema);

// 导出类型
export type BDDScenario = z.infer<typeof BDDScenarioSchema>;
export type BDDFeature = z.infer<typeof BDDFeatureSchema>;
export type BDDResult = z.infer<typeof BDDResultSchema>;
export type ArchitectureDependency = z.infer<typeof ArchitectureDependencySchema>;
export type ArchitectureFile = z.infer<typeof ArchitectureFileSchema>;
export type ArchitectureResult = z.infer<typeof ArchitectureResultSchema>;
