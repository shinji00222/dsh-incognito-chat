// 无痕会话 id 规则。
//
// 整个插件只靠 id 认出无痕会话：前端新建时用这个前缀，host 端看到就走内存。
// 官方自己生成的 id 是 `session-<uuid>`，所以 `session-incognito-<uuid>` 不会和它撞。

export const INCOGNITO_PREFIX = 'session-incognito-'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const INCOGNITO_ID = new RegExp(`^${INCOGNITO_PREFIX}${UUID}$`)

/**
 * 是不是无痕会话 id。只认「前缀 + 小写 uuid」的完整形式，宁可漏认也不误认：
 * 误认会让一个普通会话不落盘，用户以为存了其实没存。
 * @param {unknown} id
 * @returns {boolean}
 */
export function isIncognito(id) {
  return typeof id === 'string' && INCOGNITO_ID.test(id)
}

/**
 * 生成一个新的无痕会话 id。
 * @param {() => string} [uuid] 测试时可以注入固定的 uuid
 * @returns {string}
 */
export function newIncognitoId(uuid = () => crypto.randomUUID()) {
  return INCOGNITO_PREFIX + uuid()
}
