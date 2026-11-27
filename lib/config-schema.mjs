/**
 * config-schema.mjs —— 插件 Config（schemastery）。宿主拿不到 schemastery 时整块省略。
 * 这里只做「存储/校验/设置页初始值」，界面由 client.js 手写卡片渲染。
 */
export function dsimportConfigSchema(z) {
  return z.object({
    enabled: z.boolean().default(true).description('启用 DeepSeek 导入插件'),
    browserPort: z.number().min(1024).max(65535).default(47892).description('CDP 调试端口'),
    titleSuffix: z.string().default('（来自 DeepSeek）').description('导入会话标题后缀，方便识别'),
    keepReasoning: z.boolean().default(false).description('保留 DeepSeek 的思考/推理过程（默认丢弃，只留问答）'),
    markImported: z.boolean().default(true).description('是否在导入后记录原始会话 id 以便去重'),
    targetWorkspacePath: z.string().default('').description('导入会话归属的工作区目录（留空自动选择当前主工作区）'),
  });
}
