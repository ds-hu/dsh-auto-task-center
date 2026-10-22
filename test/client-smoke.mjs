#!/usr/bin/env node
/**
 * Evaluate the browser bundle against a mock Cordis context.
 *
 * The client half is a hand-written `window.__ModuleLoader__` script that no
 * bundler ever checks, so this script is its compiler: it runs the real file,
 * calls the real `apply`, and asserts that the registrations the sidebar needs
 * were actually made — the tab type, the guide entry, both slots, the locale
 * dictionaries and the stylesheet.
 *
 * It also guards the packaging rule that matters most: neither half may import
 * an `@deepseek-ai/*` module, because a profile-installed plugin cannot resolve
 * one.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

/**
 * Run one labelled assertion without aborting the audit.
 * @param {string} label - What is being checked.
 * @param {() => void | Promise<void>} fn - The check.
 * @returns {Promise<void>} resolves after reporting.
 */
async function check(label, fn) {
  try {
    await fn();
    process.stdout.write(`ok   ${label}\n`);
  } catch (error) {
    failures.push(label);
    process.stdout.write(`FAIL ${label}\n     ${String(error.message).split('\n').join('\n     ')}\n`);
  }
}

/**
 * A tiny React stand-in: enough to build the module, never to render it.
 * @returns {object} the fake module.
 */
function fakeReact() {
  const element = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } });
  return {
    createElement: element,
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  };
}

/**
 * Load the browser bundle the way the shell does.
 * @returns {Promise<{ exports: any, disposers: (() => any)[], html: string[], log: { locale: any[], tabs: any[], slots: any[] } }>} the loaded plugin.
 */
async function loadBundle() {
  const source = readFileSync(join(root, 'lib/client.js'), 'utf8');
  const created = [];
  const appended = [];
  const head = {
    children: appended,
    appendChild(node) {
      node.parentNode = head;
      appended.push(node);
      return node;
    },
    removeChild(node) {
      const index = appended.indexOf(node);
      if (index >= 0) appended.splice(index, 1);
      node.parentNode = undefined;
      return node;
    },
  };
  const document = {
    head,
    querySelector: () => null,
    createElement(tag) {
      const node = { tagName: tag, dataset: {}, textContent: '', parentNode: undefined };
      created.push(node);
      return node;
    },
  };
  const sandbox = {
    window: {},
    document,
    console,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    navigator: {},
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  let registration;
  sandbox.window.__ModuleLoader__ = {
    load(entry) {
      registration = entry;
    },
  };
  vm.runInContext(source, context, { filename: 'lib/client.js' });
  assert.ok(registration, 'the bundle did not register with __ModuleLoader__');
  assert.equal(registration.id, '@ds-hu/dsh-auto-task-center');
  const loaded = registration.factory((specifier) => {
    if (specifier === 'react') return fakeReact();
    throw new Error(`the client bundle must not require ${specifier}`);
  });

  const log = { locale: [], tabs: [], slots: [] };
  const disposers = [];
  const dictionaries = {};
  const services = {
    sidebarRight: { closeIn() {}, close() {} },
  };
  const ctx = {
    locale: {
      register(namespace, dictionary) {
        log.locale.push({ namespace, dictionary });
        dictionaries[namespace] = dictionary;
        return () => {};
      },
      bind(namespace) {
        // The real bind picks the active locale; the mock pins it to zh.
        return (key) => dictionaries[namespace]?.zh?.[key] ?? key;
      },
      current: 'zh',
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    inject(deps, callback) {
      callback(ctx);
    },
    get(name) {
      return services[name];
    },
    slots: {
      inject(name, callback) {
        callback();
      },
      register(definition) {
        log.slots.push(definition);
        return () => {};
      },
    },
    sidebarRightTabs: {
      register(definition) {
        log.tabs.push(definition);
        return () => {};
      },
    },
  };
  loaded.apply(ctx);
  return { exports: loaded, disposers, html: appended, log };
}

const loaded = await loadBundle();

await check('the bundle exports a plugin shape', () => {
  assert.equal(loaded.exports.name, 'task-center-client');
  assert.ok(Array.isArray(loaded.exports.inject));
  assert.equal(typeof loaded.exports.apply, 'function');
});

await check('both dictionaries are registered under one namespace', () => {
  assert.equal(loaded.log.locale.length, 1);
  const [entry] = loaded.log.locale;
  assert.equal(entry.namespace, 'taskCenter');
  assert.ok(entry.dictionary.zh, 'zh is required');
  assert.ok(entry.dictionary.en, 'en is required');
});

await check('the zh and en dictionaries carry the same keys', () => {
  const { zh, en } = loaded.log.locale[0].dictionary;
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  const missingInEn = zhKeys.filter((key) => !enKeys.includes(key));
  const missingInZh = enKeys.filter((key) => !zhKeys.includes(key));
  assert.deepEqual(missingInEn, [], `missing in en: ${missingInEn.join(', ')}`);
  assert.deepEqual(missingInZh, [], `missing in zh: ${missingInZh.join(', ')}`);
  assert.ok(zhKeys.length > 80, `only ${zhKeys.length} keys`);
});

await check('the right-sidebar tab type is registered with a guide entry', () => {
  assert.equal(loaded.log.tabs.length, 1);
  const definition = loaded.log.tabs[0];
  assert.equal(definition.id, '@ds-hu/dsh-auto-task-center/tasks');
  assert.equal(definition.kind, 'taskCenter');
  assert.equal(definition.priority, 'extension');
  assert.equal(typeof definition.title, 'function');
  assert.equal(definition.guide.length, 1);
  const [guide] = definition.guide;
  assert.equal(guide.id, 'tasks');
  assert.equal(typeof guide.order, 'number');
  assert.equal(typeof guide.title, 'function');
  assert.equal(typeof guide.description, 'function');
  assert.equal(typeof guide.icon, 'function');
  assert.equal(guide.title(), '任务中心');
  assert.match(guide.description(), /Webhook/u);
});

await check('the tab body and its title are registered in the sidebar slots', () => {
  const names = loaded.log.slots.map((slot) => slot.name).sort();
  assert.deepEqual(names, ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']);
  for (const slot of loaded.log.slots) {
    assert.equal(slot.key, '@ds-hu/dsh-auto-task-center/tasks');
    assert.equal(slot.locale, 'taskCenter');
  }
});

await check('exactly one owned stylesheet is attached and it is removable', () => {
  assert.equal(loaded.html.length, 1);
  const [tag] = loaded.html;
  assert.equal(tag.tagName, 'style');
  assert.equal(tag.dataset.pluginCss, '@ds-hu/dsh-auto-task-center/panel.css');
  assert.equal(tag.dataset.plugin, '@ds-hu/dsh-auto-task-center');
  assert.match(tag.textContent, /\.tc-root/u);
  for (const dispose of loaded.disposers) {
    try {
      dispose();
    } catch {
      /* the close-tabs disposer tolerates an empty map */
    }
  }
  assert.equal(loaded.html.length, 0, 'the stylesheet must be removed on dispose');
});

await check('trigger defaults cover every kind the panel offers', () => {
  const { defaultTriggerFor } = loaded.exports.__tcTest;
  assert.equal(defaultTriggerFor('webhook', undefined).kind, 'webhook');
  assert.equal(defaultTriggerFor('daily', { timeZone: 'Asia/Shanghai' }).timeZone, 'Asia/Shanghai');
  assert.equal(defaultTriggerFor('every', undefined).everySeconds, 3600);
  assert.equal(defaultTriggerFor('weekly', undefined).weekdays.join(','), '1');
  assert.equal(defaultTriggerFor('cron', undefined).expression, '0 9 * * 1-5');
  assert.ok(Date.parse(defaultTriggerFor('at', undefined).at) > Date.now());
});

await check('the panel styles only use theme tokens for colour', () => {
  const css = loaded.exports.__tcTest.CSS;
  const colours = css.match(/(?:^|[;{]\s*)(?:color|background|background-color|border-color)\s*:\s*([^;}]+)/gu) ?? [];
  for (const declaration of colours) {
    assert.match(declaration, /var\(--dsw-alias-|transparent|inherit|currentColor/u, `hard-coded colour: ${declaration}`);
  }
  assert.doesNotMatch(css, /#(?:[0-9a-f]{3}){1,2}\b/iu, 'no literal hex colours');
});

await check('neither half imports an @deepseek-ai module', () => {
  const files = readdirSync(join(root, 'lib')).filter((name) => name.endsWith('.js'));
  assert.ok(files.length > 8);
  for (const file of files) {
    const text = readFileSync(join(root, 'lib', file), 'utf8');
    assert.doesNotMatch(text, /^\s*import[^\n]*@deepseek-ai\//mu, `${file} imports a Harness package`);
    assert.doesNotMatch(text, /require\(\s*['"]@deepseek-ai\//u, `${file} requires a Harness package`);
  }
  const bin = readFileSync(join(root, 'bin/task-center.mjs'), 'utf8');
  assert.doesNotMatch(bin, /from\s+['"]@deepseek-ai\//u);
});

await check('every shipped module passes a syntax check', () => {
  const files = [
    ...readdirSync(join(root, 'lib')).filter((name) => name.endsWith('.js')).map((name) => join('lib', name)),
    join('bin', 'task-center.mjs'),
  ];
  for (const file of files) {
    execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' });
  }
});

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} check(s) failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\nclient-smoke: all checks passed\n');
}
