(() => {
  'use strict';
  if (window.__DK_STUDIO_INSPECTOR__) return;
  window.__DK_STUDIO_INSPECTOR__ = true;
  // The preview iframe intentionally has an opaque sandbox origin. The parent
  // accepts only this frame window plus a per-load nonce; neither side relies
  // on same-origin DOM access.
  const nonce = document.currentScript?.dataset.dkStudioNonce ?? '';

  let enabled = false;
  let hovered = null;
  let selected = null;
  let frame = 0;
  const overlay = document.createElement('div');
  const label = document.createElement('div');
  Object.assign(overlay.style, {
    position: 'fixed', display: 'none', pointerEvents: 'none', zIndex: '2147483646',
    border: '2px solid Highlight', background: 'color-mix(in srgb, Highlight 9%, transparent)',
    boxSizing: 'border-box', transition: 'left 60ms, top 60ms, width 60ms, height 60ms',
  });
  Object.assign(label.style, {
    position: 'absolute', left: '-2px', bottom: '100%', maxWidth: 'min(520px, 90vw)',
    padding: '5px 8px', color: 'HighlightText', background: 'Highlight',
    font: '600 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    borderRadius: '4px 4px 0 0', boxShadow: 'none',
  });
  overlay.append(label);

  const mount = () => {
    if (!overlay.isConnected && document.documentElement) document.documentElement.append(overlay);
  };

  const post = (type, payload = {}) => {
    if (window.parent === window) return;
    if (!nonce) return;
    window.parent.postMessage({ source: 'dk-studio-preview', nonce, type, payload }, '*');
  };

  const show = (element) => {
    if (!enabled || !element || element === overlay || element === label) return;
    mount();
    hovered = element;
    const rect = element.getBoundingClientRect();
    Object.assign(overlay.style, {
      display: 'block', left: `${Math.max(0, rect.left)}px`, top: `${Math.max(0, rect.top)}px`,
      width: `${Math.max(0, rect.width)}px`, height: `${Math.max(0, rect.height)}px`,
    });
    label.textContent = selectorFor(element);
  };

  const inspect = (element, reason) => {
    if (!element || element === overlay || element === label) return;
    selected = element;
    show(element);
    const rect = element.getBoundingClientRect();
    post('dk-studio:selection', {
      reason,
      selector: selectorFor(element),
      tag: element.tagName.toLowerCase(),
      text: compactText(element.textContent),
      box: {
        x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height),
      },
      attributes: usefulAttributes(element),
      component: componentClue(element),
      tokens: tokenClues(element),
      classes: [...element.classList].slice(0, 12),
      page: { href: location.href, title: document.title },
    });
  };

  document.addEventListener('pointermove', (event) => {
    if (!enabled) return;
    const target = event.target;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => show(target));
  }, true);

  document.addEventListener('click', (event) => {
    if (!enabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    inspect(event.target, 'click');
  }, true);

  document.addEventListener('keydown', (event) => {
    if (!enabled || event.key !== 'Escape') return;
    enabled = false;
    overlay.style.display = 'none';
    post('dk-studio:inspector-state', { enabled: false, reason: 'escape' });
  }, true);

  window.addEventListener('scroll', () => {
    if (enabled && (selected || hovered)) show(selected || hovered);
  }, true);

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.source !== 'dk-studio' || !nonce || message.nonce !== nonce) return;
    if (message.type === 'dk-studio:inspector:set') {
      enabled = !!message.payload?.enabled;
      if (!enabled) overlay.style.display = 'none';
      else if (selected || hovered) show(selected || hovered);
      post('dk-studio:inspector-state', { enabled });
    }
    if (message.type === 'dk-studio:inspect-request' && (selected || hovered)) inspect(selected || hovered, 'request');
    if (message.type === 'dk-studio:reload') location.reload();
  });

  function selectorFor(element) {
    if (!(element instanceof Element)) return '';
    if (element.id) return `#${escapeCss(element.id)}`;
    for (const attribute of ['data-testid', 'data-component', 'data-ui', 'aria-label']) {
      const value = element.getAttribute(attribute);
      if (value) return `[${attribute}="${escapeAttr(value)}"]`;
    }
    const parts = [];
    let current = element;
    for (let depth = 0; current && current.nodeType === 1 && depth < 6; depth++) {
      let part = current.tagName.toLowerCase();
      const stableClasses = [...current.classList].filter((name) => name.length < 50 && !/[0-9a-f]{7,}/i.test(name)).slice(0, 2);
      if (stableClasses.length) part += stableClasses.map((name) => `.${escapeCss(name)}`).join('');
      const siblings = current.parentElement ? [...current.parentElement.children].filter((child) => child.tagName === current.tagName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
      if (current.parentElement?.id) {
        parts.unshift(`#${escapeCss(current.parentElement.id)}`);
        break;
      }
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function componentClue(element) {
    let current = element;
    for (let depth = 0; current && depth < 8; depth++, current = current.parentElement) {
      for (const key of ['data-component', 'data-ui', 'data-part', 'data-testid']) {
        if (current.hasAttribute?.(key)) return { name: current.getAttribute(key), source: key, depth };
      }
      if (current.tagName?.includes('-')) return { name: current.tagName.toLowerCase(), source: 'custom-element', depth };
      const vue = current.__vueParentComponent?.type;
      if (vue?.name || vue?.__name) return { name: vue.name || vue.__name, source: 'vue-runtime', depth };
      const reactKey = Object.keys(current).find((key) => key.startsWith('__reactFiber$'));
      let fiber = reactKey ? current[reactKey] : null;
      for (let hop = 0; fiber && hop < 8; hop++, fiber = fiber.return) {
        const type = fiber.type;
        const name = type?.displayName || type?.name;
        if (name && !/^(?:Fragment|Suspense)$/.test(name)) return { name, source: 'react-runtime', depth };
      }
    }
    const classHint = [...element.classList].find((name) => /^[A-Z][A-Za-z0-9_-]+$/.test(name));
    return classHint ? { name: classHint, source: 'class', depth: 0 } : null;
  }

  function tokenClues(element) {
    const clues = [];
    const seen = new Set();
    const addFromStyle = (style, selector) => {
      if (!style) return;
      for (let index = 0; index < style.length; index++) {
        const property = style[index];
        const value = style.getPropertyValue(property);
        for (const match of value.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
          const key = `${property}:${match[1]}`;
          if (seen.has(key)) continue;
          seen.add(key);
          clues.push({ property, token: match[1], selector, value: getComputedStyle(element).getPropertyValue(property).trim() });
        }
      }
    };
    addFromStyle(element.style, 'inline');
    for (const sheet of [...document.styleSheets]) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      walkRules(rules, (rule) => {
        if (!rule.selectorText || !rule.style) return;
        let matches = false;
        try { matches = element.matches(rule.selectorText); } catch { /* invalid/unsupported selector */ }
        if (matches) addFromStyle(rule.style, rule.selectorText);
      });
      if (clues.length >= 16) break;
    }
    return clues.slice(0, 16);
  }

  function walkRules(rules, visit) {
    for (const rule of [...(rules || [])]) {
      visit(rule);
      if (rule.cssRules) walkRules(rule.cssRules, visit);
    }
  }

  function usefulAttributes(element) {
    const out = {};
    for (const attribute of [...element.attributes]) {
      if (/^(?:id|role|name|type|href|aria-|data-)/.test(attribute.name)) out[attribute.name] = attribute.value.slice(0, 160);
      if (Object.keys(out).length >= 16) break;
    }
    return out;
  }

  function escapeCss(value) {
    if (window.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
  }
  function escapeAttr(value) { return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
  function compactText(value) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 240); }
  function round(value) { return Math.round(value * 10) / 10; }

  mount();
  post('dk-studio:ready', { href: location.href, title: document.title, inspector: true });
})();
