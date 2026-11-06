// No unowned call may fall through to the shared attachment store.
export function patchAttachmentStore(store, context, pool) {
  const methods = [
    'saveImage', 'saveImages', 'saveFile', 'saveFileStream',
    'readImage', 'readImageRequest', 'readFileStream', 'imageHostPath', 'fileHostPath',
  ]
  for (const name of methods) {
    if (typeof store?.[name] !== 'function') throw new Error(`unsupported attachment store: ${name}`)
  }
  const originals = new Map(methods.map(name => [name, store[name]]))
  const wrappers = new Map()
  const owned = () => {
    const current = context.current()
    if (!current?.sessionId) throw new Error('附件操作缺少对话归属，已停止以避免写入普通附件目录')
    return current
  }
  const route = {
    async saveImage(id, input) { return (await pool.saveImage(id, input)).ref },
    async saveImages(id, inputs) { return (await pool.saveImages(id, inputs)).map(entry => entry.ref) },
    async saveFile(id, input) { return (await pool.saveFile(id, input)).ref },
    async saveFileStream(id, input) { return (await pool.saveFileStream(id, input)).ref },
    readImage(id, ref, signal) { return pool.readImage(id, pool.reference(id, 'image', ref).token, ref, signal) },
    readImageRequest(id, ref, target, signal) { return pool.readImageRequest(id, pool.reference(id, 'image', ref).token, ref, target, signal) },
    readFileStream(id, ref, signal) { return pool.readFileStream(id, pool.reference(id, 'file', ref).token, ref, signal) },
    imageHostPath(id, ref) { return pool.reference(id, 'image', ref).path },
    fileHostPath(id, ref) { return pool.reference(id, 'file', ref).path },
  }
  try {
    for (const name of methods) {
      const original = originals.get(name)
      function wrapped(...args) {
        const owner = owned()
        return owner.incognito ? route[name](owner.sessionId, ...args) : original.apply(this, args)
      }
      store[name] = wrapped
      if (store[name] !== wrapped) throw new Error(`cannot wrap attachment store: ${name}`)
      wrappers.set(name, wrapped)
    }
  } catch (error) {
    for (const [name, wrapped] of wrappers) if (store[name] === wrapped) store[name] = originals.get(name)
    throw error
  }
  return () => {
    for (const [name, wrapped] of wrappers) if (store[name] === wrapped) store[name] = originals.get(name)
  }
}
