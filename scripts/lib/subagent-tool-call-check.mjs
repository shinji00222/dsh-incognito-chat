// M11 模型工具入口验收的纯判定逻辑。
//
// 这里只做「工具结果能不能归因于无痕 guard」的分类；不做任何 I/O，方便单元测试。
// 关键安全属性：
//   - 只有 tool/result 的文本是 guard 自己的拒绝消息时，才算无痕保护通过；
//   - 参数校验（ToolArgsError / INVALID_ARGS）、工具不可用（ToolNotFoundError /
//     UNKNOWN_TOOL）、审批阶段（approval ...）以及没有 tool/result 的情况，
//     一律标为 unverified，不能当成保护通过；
//   - 工具真正执行（isError=false / 成功）说明保护没有拦截，标为 fail。

export const GUARD_MESSAGE = '无痕对话暂不支持启动子 agent，避免子会话留下记录'

/**
 * @typedef {{ stage: 'guard'|'executed'|'parameter-validation'|'tool-unavailable'|'approval'|'missing'|'other-error', detail: string }} ToolResultClassification
 */

/**
 * 把一个 `tool/result` 会话事件归类到工具链的哪个阶段。
 * @param {{ callId?: string, isError?: boolean, text?: string, error?: { name?: string, code?: string } | null } | undefined} result
 * @returns {ToolResultClassification}
 */
export function classifyToolResult(result) {
  if (result === undefined) return { stage: 'missing', detail: 'no tool/result event for the mock tool call id' }
  const name = result.error?.name ?? ''
  const code = result.error?.code ?? ''
  const text = result.text ?? ''
  if (name === 'ToolArgsError' || code === 'INVALID_ARGS') return { stage: 'parameter-validation', detail: `${name} ${code} ${text}` }
  if (name === 'ToolNotFoundError' || code === 'UNKNOWN_TOOL') return { stage: 'tool-unavailable', detail: `${name} ${code} ${text}` }
  if (/approval|requires approval|approval channel|approval for tool|approvalCancelled/i.test(`${text} ${name} ${code}`)) return { stage: 'approval', detail: `${name} ${code} ${text}` }
  if (text.includes(GUARD_MESSAGE)) return { stage: 'guard', detail: text }
  if (result.isError === false || result.isError === undefined) return { stage: 'executed', detail: text }
  return { stage: 'other-error', detail: `${name} ${code} ${text}` }
}

/**
 * 无痕父会话的验收结论：只有 guard 拒绝才能判 pass。
 * @param {ToolResultClassification['stage']} stage
 * @returns {'pass'|'fail'|'unverified'}
 */
export function assessIncognitoToolOutcome(stage) {
  if (stage === 'guard') return 'pass'
  if (stage === 'executed') return 'fail'
  return 'unverified'
}
