// 把一个活着的会话从 DSH 内存里真正释放掉。
//
// 官方没有「关闭某个会话」的公开接口（归档也只是停掉，不释放）。
// agent-loop 创建 agent 时会登记两个带名字的 cordis effect：
//   - `agentLoop.lifecycle(<id>)`：挂在创建者（会话控制器）的 fiber 上，
//     它的清理函数 = 完整 teardown（取消回合、关句柄、从 agents / sessions 注册表摘掉）
//     + 撤掉 scope effect。官方插件卸载时就是走这条路。
//   - `agentLoop.scope(<id>)`：挂在 agent-loop 自己的 fiber 上，清理函数也会调 teardown。
// 我们按名字找到 effect，调用它的清理函数。找不到就如实报告，不假装释放了。
//
// 只实测过 DSH 0.2.1-rc.5。依赖内部实现：effect 的 label、fiber._disposables、
// Symbol.for('cordis.effect')。升级后找不到时 released=false，会话等 DSH 退出才没。

const EFFECT = Symbol.for('cordis.effect')

/**
 * 在所有插件 fiber 里按 label 找 effect 的清理函数。
 * @param {any} registry ctx.registry（cordis 的插件注册表）
 * @param {string} label
 * @returns {(() => unknown) | undefined}
 */
export function findEffect(registry, label) {
  if (typeof registry?.values !== 'function') return undefined
  for (const runtime of registry.values()) {
    for (const fiber of runtime?.fibers ?? []) {
      for (const disposer of fiber?._disposables ?? []) {
        if (typeof disposer === 'function' && disposer[EFFECT]?.label === label) return disposer
      }
    }
  }
  return undefined
}

/**
 * 释放一个会话。先找 lifecycle effect（最完整），找不到再退到 scope effect。
 * @param {any} registry ctx.registry
 * @param {string} id 会话 id
 * @returns {Promise<'lifecycle' | 'scope' | 'not-found'>} 走的是哪条路
 */
export async function releaseSession(registry, id) {
  for (const [kind, label] of /** @type {const} */ ([
    ['lifecycle', `agentLoop.lifecycle(${id})`],
    ['scope', `agentLoop.scope(${id})`],
  ])) {
    const disposer = findEffect(registry, label)
    if (disposer) {
      await disposer()
      return kind
    }
  }
  return 'not-found'
}
