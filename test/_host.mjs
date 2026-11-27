/**
 * test/_host.mjs —— 可移植地定位 DSH 宿主自带的 @deepseek-ai 包，供集成测试 import。
 *
 * 这些测试需要宿主（DeepSeek Harness / dsh CLI）自带的包（cordis、dsh-session、
 * dsh-session-persistence-jsonl 等），它们在「装了 dsh 的机器」上才有。为了不在
 * 其它机器上报错崩溃，这里按多个候选目录查找；找不到就返回 ready=false，
 * 调用方据此跳过（打印 skip）而不是 fail。
 *
 * 不包含任何硬编码的本机绝对路径：全部基于环境变量 / 标准安装位置动态推导。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');

/** @deepseek-ai 包可能所在的 node_modules 根目录（去重、仅保留存在的）。 */
export function candidateRoots() {
  const roots = [];
  const push = (p) => { if (p && !roots.includes(p)) roots.push(p); };
  // 1) 显式覆盖
  push(process.env.DSH_HOST_MODULES);
  // 2) 本插件自身所在的 node_modules（插件被装进 profile 时，@deepseek-ai 常在同级）
  push(join(process.cwd(), 'node_modules', '@deepseek-ai'));
  // 3) profile 的 node_modules
  push(join(DSH_HOME, 'profiles', 'desktop', 'node_modules', '@deepseek-ai'));
  push(join(DSH_HOME, 'node_modules', '@deepseek-ai'));
  // 4) npm 全局（Windows：%APPDATA%\npm\node_modules；*nix：/usr/lib/node_modules）
  if (process.env.APPDATA) push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai'));
  push('/usr/lib/node_modules/@deepseek-ai');
  push('/usr/local/lib/node_modules/@deepseek-ai');
  // 5) dsh CLI 本地安装（Windows：%LOCALAPPDATA%\dsh-cli\node_modules）
  if (process.env.LOCALAPPDATA) push(join(process.env.LOCALAPPDATA, 'dsh-cli', 'node_modules', '@deepseek-ai'));
  return roots.filter((r) => existsSync(r));
}

/** 找到包含某个子包（rel，如 'cordis/lib/index.js'）的根，否则 undefined。 */
export function findHostRoot(rel = 'cordis/lib/index.js') {
  for (const r of candidateRoots()) {
    if (existsSync(join(r, rel))) return r;
  }
  return undefined;
}

/** 返回 ready + import 函数；ready=false 时 addImp 会抛可被识别为「跳过」的错误。 */
export function makeHostImporter(rel = 'cordis/lib/index.js') {
  const root = findHostRoot(rel);
  const ready = !!root;
  const imp = (p) => {
    if (!root) throw new Error('HOST_PKGS_NOT_FOUND');
    return import(pathToFileURL(join(root, p)).href);
  };
  return { ready, root, imp };
}
