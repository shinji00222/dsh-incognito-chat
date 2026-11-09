// M10 判定逻辑：从本地模拟服务端抓到的真实请求体里，判断
//   1. 普通会话对照确实带 dsh_session_log（否则整次验证无效，必须失败）
//   2. 无痕会话没有 dsh_session_log
//   3. 无痕请求仍包含正常对话字段和这轮合成消息
//
// 这个文件只做纯函数判定，方便单元测试；抓请求和启动隔离 DSH 在
// scripts/verify-session-log-request.mjs 里。

export const FIELD = 'dsh_session_log'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * @param {unknown} body 请求体（已解析的 JSON）
 * @returns {string} 用于搜索合成探针的对话文本
 */
export function conversationText(body) {
  if (!isObject(body)) return ''
  const parts = []
  if (typeof body.system === 'string') parts.push(body.system)
  if (Array.isArray(body.system)) parts.push(JSON.stringify(body.system))
  if (Array.isArray(body.messages)) parts.push(JSON.stringify(body.messages))
  return parts.join('\n')
}

/**
 * @param {object} input
 * @param {unknown} input.normalBody 普通对照会话的请求体
 * @param {unknown} input.incognitoBody 无痕会话的请求体
 * @param {string} input.normalProbe 普通会话的合成探针
 * @param {string} input.incognitoProbe 无痕会话的合成探针
 * @returns {{ok: boolean, findings: Array<{severity: 'error'|'warning', code: string, message: string}>}}
 */
export function checkCapturedRequests({ normalBody, incognitoBody, normalProbe, incognitoProbe }) {
  /** @type {Array<{severity: 'error'|'warning', code: string, message: string}>} */
  const findings = []
  const error = (code, message) => findings.push({ severity: 'error', code, message })
  const warning = (code, message) => findings.push({ severity: 'warning', code, message })

  if (!isObject(normalBody)) {
    error('NORMAL_REQUEST_MISSING', '没有抓到普通对照会话的模型请求，无法证明无痕通过')
    return { ok: false, findings }
  }
  if (!isObject(incognitoBody)) {
    error('INCOGNITO_REQUEST_MISSING', '没有抓到无痕会话的模型请求')
    return { ok: false, findings }
  }

  // ── 对照：普通会话必须带字段，而且字段确实属于这一轮合成对话 ──────────
  const hasField = Object.hasOwn(normalBody, FIELD)
  if (!hasField) {
    error(
      'CONTROL_MISSING_FIELD',
      `普通对照请求没有 ${FIELD}：日志插件没有按预期触发，这次验证不能证明无痕生效（不得当作通过）`,
    )
  } else if (!isObject(normalBody[FIELD])) {
    error('CONTROL_FIELD_NOT_OBJECT', `普通对照请求的 ${FIELD} 不是对象，不能当作有效对照`)
  } else if (!JSON.stringify(normalBody[FIELD]).includes(normalProbe)) {
    error(
      'CONTROL_FIELD_WITHOUT_PROBE',
      `普通对照请求的 ${FIELD} 里没有合成探针 ${normalProbe}，无法证明抓到的就是这一轮对话`,
    )
  }
  if (!conversationText(normalBody).includes(normalProbe)) {
    error('CONTROL_CONVERSATION_MISSING_PROBE', `普通对照请求的 messages/system 里没有合成探针 ${normalProbe}`)
  }

  // ── 无痕：不能出现字段，但对话本身要照常发出去 ────────────────────────
  if (Object.hasOwn(incognitoBody, FIELD)) {
    const serialized = JSON.stringify(incognitoBody[FIELD])
    error(
      'INCOGNITO_HAS_FIELD',
      `无痕会话请求里仍然有 ${FIELD}（${serialized?.slice(0, 120) ?? 'null'}）`,
    )
  }
  if (!conversationText(incognitoBody).includes(incognitoProbe)) {
    error(
      'INCOGNITO_CONVERSATION_MISSING_PROBE',
      `无痕请求里没有消息探针 ${incognitoProbe}：可能请求没有走正常对话链路，或抓错了请求`,
    )
  }
  if (!Array.isArray(incognitoBody.messages) || incognitoBody.messages.length === 0) {
    error('INCOGNITO_MESSAGES_MISSING', '无痕请求没有 messages 数组，正常对话字段不完整')
  }
  if (!('model' in incognitoBody)) error('INCOGNITO_MODEL_MISSING', '无痕请求没有 model 字段，正常请求结构不完整')

  // 两条请求应属于同一模型路由；不同则说明抓到的对照和无痕不是同一次验证。
  if (
    typeof normalBody.model === 'string' &&
    typeof incognitoBody.model === 'string' &&
    normalBody.model !== incognitoBody.model
  ) {
    warning(
      'MODEL_MISMATCH',
      `普通请求 model=${normalBody.model}，无痕请求 model=${incognitoBody.model}；对照条件不完全一致`,
    )
  }

  return { ok: findings.every((entry) => entry.severity !== 'error'), findings }
}

/** @param {{ok: boolean, findings: Array<{severity: string, code: string, message: string}>}} result */
export function formatFindings(result) {
  const lines = result.findings.map((entry) => `${entry.severity === 'error' ? 'ERROR' : 'WARN'} ${entry.code}: ${entry.message}`)
  lines.push(result.ok ? 'RESULT: PASS' : 'RESULT: FAIL')
  return lines.join('\n')
}
