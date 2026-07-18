function resolveBindingChange(current, next) {
  if (!current) return { changed: true, next };
  if (current.sessionId !== next.sessionId) return { changed: true, next };
  if (current.generation !== next.generation) return { changed: true, next };
  return { changed: false, next };
}

module.exports = { resolveBindingChange };
