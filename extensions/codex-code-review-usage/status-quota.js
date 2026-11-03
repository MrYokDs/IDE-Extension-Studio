'use strict';
function primaryWindow(windows = []) {
  return windows.find(window => window.label === 'Weekly' && window.remainingPercent === 0)
    || windows.find(window => window.label === '5 hour')
    || windows.find(window => window.label === '15 minute') || windows[0] || null;
}
function antigravitySelection(value, selectedId) {
  const model = value?.models?.find(model => model.id === selectedId) || value?.models?.[0] || null;
  if (!model) return { model: null, window: null };
  const identity = `${model.id} ${model.name}`.toLowerCase();
  const family = identity.includes('gemini') ? 'gemini' : /claude|gpt/.test(identity) ? 'third-party' : null;
  const group = family ? value.groups?.find(group => group.family === family) : null;
  const weekly = group?.windows.find(window => window.label === 'Weekly' && window.remainingPercent === 0);
  return { model, window: weekly || (model.quota ? { ...model.quota, label: '5 hour' } : primaryWindow(group?.windows)) };
}
module.exports = { primaryWindow, antigravitySelection };
