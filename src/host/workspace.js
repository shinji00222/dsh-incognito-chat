// 工作区记录里的无痕 id 清理。
//
// 为什么要挂进工作区：DSH 前端靠「工作区包含哪些会话」来决定当前会话属于哪个工作区；
// 不挂进去，输入框会因为「没有选择工作区」被禁用，根本发不了消息（实测踩过）。
// 代价：官方会把会话 id 写进 ~/.dsh/storages/workspace.json（只有 id，没有任何内容）。
// 所以：丢弃无痕会话时立刻移除，插件启动时再扫一遍残留（比如 DSH 崩溃后）。

import { isIncognito } from './ids.js'

/**
 * 工作区实体里原始的会话 id 列表（`sessionIds` getter 会过滤掉找不到 header 的 id，
 * 而崩溃残留的无痕 id 正好找不到 header，所以要读 record 里的原始值）。
 * @param {any} workspace
 * @returns {string[]}
 */
function rawSessionIds(workspace) {
  const ids = workspace?.record?.sessionIds ?? workspace?.sessionIds
  return Array.isArray(ids) ? ids : []
}

/**
 * 把无痕 id 从工作区记录里移除。
 * @param {any} registry ctx.workspaceRegistry
 * @param {(id: string) => boolean} [which] 只移除满足条件的 id，默认全部无痕 id
 * @returns {Promise<string[]>} 移除了哪些 id
 */
export async function detachIncognito(registry, which = isIncognito) {
  const removed = []
  const workspaces = typeof registry?.list === 'function' ? registry.list() : []
  for (const workspace of workspaces) {
    if (typeof workspace?.detachSession !== 'function') continue
    for (const id of rawSessionIds(workspace)) {
      if (!isIncognito(id) || !which(id)) continue
      await workspace.detachSession(id)
      removed.push(id)
    }
  }
  return removed
}
