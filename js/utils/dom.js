/**
 * dom.js —— 极简 DOM 助手，替代模板字符串拼接，避免 XSS 与转义问题。
 */

/** querySelector */
export function $(selector, root = document) {
  return root.querySelector(selector);
}

/** querySelectorAll → 数组 */
export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/**
 * 创建元素。
 * @param {string} tag
 * @param {Object} [attrs] class/text/html/dataset/onXxx/其它属性
 * @param {...(Node|string|Array|null|false|undefined)} children
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

/** 批量插入子节点（自动展平、跳过空值） */
export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** 清空子节点 */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}
