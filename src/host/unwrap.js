// cordis 给每个服务套了一层 Proxy（用来跟踪是哪个插件在调用）。
// 在代理上赋值 `svc.create = fn` 会被转到一个「影子」对象上，读回来也是包了一层的函数，
// 所以必须拿到代理背后的原始对象再打补丁。cordis 用这个 symbol 暴露原始对象。
const ORIGINAL = Symbol.for('cordis.original')

/**
 * @template T
 * @param {T} service
 * @returns {T}
 */
export function unwrapService(service) {
  const raw = /** @type {any} */ (service)?.[ORIGINAL]
  return raw ?? service
}
