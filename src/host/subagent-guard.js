import { isIncognito } from './ids.js'

// DSH generates ordinary child IDs. Until child storage and external providers
// are isolated, prevent managed child startup before either can be created.
export function patchSubagentStart(service) {
  if (typeof service?.startActivation !== 'function') throw new Error('unsupported subagent service')
  const original = service.startActivation
  const hadOwn = Object.hasOwn(service, 'startActivation')
  function startActivation(spec) {
    const parentId = spec?.request?.parent?.session?.id
    if (isIncognito(parentId)) throw new Error('无痕对话暂不支持启动子 agent，避免子会话留下记录')
    return original.call(this, spec)
  }
  service.startActivation = startActivation
  if (service.startActivation !== startActivation) throw new Error('cannot protect subagent startup')
  return () => {
    if (service.startActivation !== startActivation) return
    if (hadOwn) service.startActivation = original
    else delete service.startActivation
  }
}
