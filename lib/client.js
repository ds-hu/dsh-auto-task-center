window.__ModuleLoader__.load({
	id: "@ds-hu/dsh-auto-task-center",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const { useState, useEffect, useRef, useCallback, useMemo } = react;
		const h = react.createElement;

		const NS = "taskCenter";
		const API_BASE = "/task-center/api";
		const TAB_ID = "@ds-hu/dsh-auto-task-center/tasks";
		const TAB_KIND = "taskCenter";
		const CSS_TAG = "@ds-hu/dsh-auto-task-center/panel.css";

		/* ================================================================ */
		/* runtime state shared with the disposer                            */
		/* ================================================================ */

		/** Live plugins can appear more than once (HMR, remount); one translate function is enough. */
		let tt = (key) => key;
		/** appCtx lets helpers read the current locale without prop drilling. */
		let appCtx = null;
		/** sessionId → the tab id our panel occupied, so dispose can close it. */
		const openTabs = new Map();

		function t(key, params) {
			const raw = tt(key, params);
			if (raw === key && params) {
				let out = key;
				for (const name of Object.keys(params)) out = out.replace("{" + name + "}", String(params[name]));
				return out;
			}
			return raw;
		}

		function currentLang() {
			// The locale service reports the active language through its snapshot;
			// `active` is a bare tag such as "en" or "zh-CN".
			try {
				const locale = appCtx && appCtx.locale;
				const snapshot = typeof locale?.getLocale === "function" ? locale.getLocale() : undefined;
				const active = typeof snapshot?.active === "string" ? snapshot.active : undefined;
				if (active !== undefined && active.toLowerCase().startsWith("en")) return "en";
			} catch {
				/* fall through to the plugin default */
			}
			return "zh";
		}

		/* ================================================================ */
		/* small utilities                                                   */
		/* ================================================================ */

		function cx() {
			let out = "";
			for (let i = 0; i < arguments.length; i += 1) {
				const part = arguments[i];
				if (part) out += (out === "" ? "" : " ") + part;
			}
			return out;
		}

		async function apiFetch(path, options) {
			const response = await fetch(API_BASE + path, {
				...(options || {}),
				headers: {
					Accept: "application/json",
					...(options && options.body !== undefined ? { "Content-Type": "application/json" } : {}),
					...(options && options.headers ? options.headers : {}),
				},
			});
			let body = null;
			try {
				body = await response.json();
			} catch {
				/* a non-JSON body is reported through the status code */
			}
			if (!response.ok || (body && body.ok === false)) {
				const message = (body && (body.error || body.code)) || "HTTP " + response.status;
				const error = new Error(message);
				error.status = response.status;
				error.code = body && body.code;
				throw error;
			}
			return body;
		}

		function apiGet(path) {
			return apiFetch(path, { method: "GET" });
		}

		function apiPost(path, body) {
			return apiFetch(path, { method: "POST", body: JSON.stringify(body === undefined ? {} : body) });
		}

		/** Display names the Host does not carry for its four built-in presets. */
		const BUILT_IN_PRESETS = {
			standard: { zh: "标准模式", en: "Standard mode" },
			ptc: { zh: "PTC 模式", en: "PTC mode" },
			minimal: { zh: "极简模式", en: "Minimal mode" },
			cordis: { zh: "创造模式", en: "Creator mode" },
		};

		/**
		 * The label for one preset from the Host roster.
		 * @param {{ id: string, name?: string }} preset - Roster entry.
		 * @returns {string} a human label.
		 */
		function presetLabel(preset) {
			if (typeof preset.name === "string" && preset.name !== "" && preset.name !== preset.id) return preset.name;
			const builtIn = BUILT_IN_PRESETS[preset.id];
			if (builtIn !== undefined) return currentLang() === "en" ? builtIn.en : builtIn.zh;
			return preset.id;
		}

		function basename(path) {
			if (typeof path !== "string" || path === "") return "";
			const clean = path.replace(/[\\/]+$/, "");
			const parts = clean.split(/[\\/]/);
			return parts[parts.length - 1] || clean;
		}

		function pad(value) {
			return String(value).padStart(2, "0");
		}

		/** `YYYY-MM-DDTHH:mm` in the browser's zone, for an `<input type="datetime-local">`. */
		function toLocalInput(iso) {
			const date = new Date(iso);
			if (Number.isNaN(date.getTime())) return "";
			return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate())
				+ "T" + pad(date.getHours()) + ":" + pad(date.getMinutes());
		}

		/** The ISO instant for a `datetime-local` value, or undefined when it is not a date. */
		function fromLocalInput(value) {
			const date = new Date(value);
			return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
		}

		function browserZone() {
			try {
				return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
			} catch {
				return "UTC";
			}
		}

		/** A short, local, human rendering of an instant. */
		function formatClock(iso) {
			const date = new Date(iso);
			if (Number.isNaN(date.getTime())) return iso;
			if (currentLang() === "en") return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
			return date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
		}

		/** Relative distance to an instant, in the reader's language. */
		function formatRelative(iso) {
			const date = new Date(iso);
			if (Number.isNaN(date.getTime())) return iso;
			const delta = date.getTime() - Date.now();
			const abs = Math.abs(delta);
			const minutes = Math.round(abs / 60000);
			const hours = Math.round(abs / 3600000);
			const days = Math.round(abs / 86400000);
			const future = delta > 0;
			if (minutes < 1) return t("time.justNow");
			if (minutes < 60) return t(future ? "time.inMinutes" : "time.minutesAgo", { n: minutes });
			if (hours < 48) return t(future ? "time.inHours" : "time.hoursAgo", { n: hours });
			return t(future ? "time.inDays" : "time.daysAgo", { n: days });
		}

		function timezoneOptions(selected) {
			let zones = [];
			try {
				zones = Intl.supportedValuesOf("timeZone");
			} catch {
				/* older engines get the short list below */
			}
			if (zones.length === 0) zones = ["UTC", "Asia/Shanghai", "Asia/Tokyo", "Europe/London", "America/New_York"];
			if (selected && zones.indexOf(selected) < 0) zones = [selected].concat(zones);
			return zones;
		}

		function triggerSummary(trigger) {
			switch (trigger && trigger.kind) {
				case "at": return t("summary.once", { at: formatClock(trigger.at) });
				case "every": {
					const minutes = Math.max(1, Math.round(trigger.everySeconds / 60));
					return minutes % 60 === 0
						? t("summary.everyHours", { n: minutes / 60 })
						: t("summary.everyMinutes", { n: minutes });
				}
				case "daily": return t("summary.daily", { time: trigger.time.slice(0, 5), zone: trigger.timeZone });
				case "weekly": return t("summary.weekly", {
					days: trigger.weekdays.map((day) => t("weekday." + day)).join(" "),
					time: trigger.time.slice(0, 5),
					zone: trigger.timeZone,
				});
				case "cron": return "Cron · " + trigger.expression;
				case "webhook": return t("trigger.webhook");
				default: return "";
			}
		}

		function targetSummary(target, state) {
			if (!target) return "";
			if (target.kind === "session") {
				const known = state && state.sessionsById ? state.sessionsById[target.sessionId] : undefined;
				// Session ids read `session-<uuid>`; the prefix is noise in a one-line
				// summary, so drop it before shortening to eight characters.
				const bare = String(target.sessionId ?? "").replace(/^session-/u, "");
				return t("summary.session", { label: known || bare.slice(0, 8) || "—" });
			}
			const workspace = state && state.workspaces ? state.workspaces.find((item) => item.id === target.workspaceId) : undefined;
			const where = workspace ? workspace.title : (target.cwd || target.workspaceId || "");
			return t("summary.newSession", { where: where === "" ? "—" : where });
		}

		/* ================================================================ */
		/* dictionaries                                                      */
		/* ================================================================ */

		const zh = {
			// The tab strip is narrow; the panel heading carries the full name.
			"tab.title": "任务",
			"guide.title": "任务中心",
			"guide.description": "管理定时任务与 Webhook 任务",

			"panel.new": "新建任务",
			"panel.search": "搜索任务",
			"panel.refresh": "刷新",
			"panel.loading": "加载中…",
			"panel.empty": "还没有任务",
			"panel.emptyHint": "点右上角「新建任务」开始",
			"panel.emptyFiltered": "没有符合条件的任务",
			"panel.retry": "重试",

			"filter.all": "全部",
			"filter.enabled": "已启用",
			"filter.disabled": "已停用",
			"filter.attention": "需处理",

			"status.active": "已启用",
			"status.inactive": "已停用",
			"status.attention": "需处理",
			"list.next": "下次",
			"list.never": "不会触发",

			"detail.back": "返回",
			"detail.save": "保存",
			"detail.saving": "保存中…",
			"detail.cancel": "取消",
			"detail.delete": "删除任务",
			"detail.deleteConfirm": "再点一次确认删除",
			"detail.newTitle": "新建任务",

			"section.basic": "基本",
			"section.trigger": "触发",
			"section.delivery": "投递",
			"section.webhook": "Webhook",
			"section.history": "运行记录",

			"field.name": "任务名称",
			"field.namePlaceholder": "例如：每日代码巡检",
			"field.enabled": "启用此任务",
			"field.enabledHint": "关闭后不再触发，配置与记录都保留",

			"trigger.kind": "触发方式",
			"trigger.at": "指定时刻（单次）",
			"trigger.every": "固定间隔",
			"trigger.daily": "每天",
			"trigger.weekly": "每周",
			"trigger.cron": "Cron 表达式",
			"trigger.webhook": "Webhook",
			"trigger.atLabel": "触发时间",
			"trigger.everyValue": "间隔",
			"trigger.unit.minutes": "分钟",
			"trigger.unit.hours": "小时",
			"trigger.time": "时间",
			"trigger.zone": "时区",
			"trigger.weekdays": "星期",
			"trigger.cronLabel": "表达式",
			"trigger.cronHint": "五段式：分 时 日 月 周，例如 0 9 * * 1-5",
			"trigger.preview": "接下来 5 次",
			"trigger.previewEmpty": "无法计算下次触发，检查表达式与时区",

			"summary.once": "{at} 一次",
			"summary.everyMinutes": "每 {n} 分钟",
			"summary.everyHours": "每 {n} 小时",
			"summary.daily": "每天 {time} · {zone}",
			"summary.weekly": "每周 {days} {time} · {zone}",
			"summary.session": "会话 {label}",
			"summary.newSession": "新建会话 · {where}",

			"weekday.1": "一",
			"weekday.2": "二",
			"weekday.3": "三",
			"weekday.4": "四",
			"weekday.5": "五",
			"weekday.6": "六",
			"weekday.7": "日",

			"target.kind": "投递到",
			"target.newSession": "新建会话",
			"target.session": "指定会话",
			"target.workspace": "工作区",
			"target.cwd": "目录",
			"target.preset": "预设",
			"target.presetHint": "「任务管理」由本插件提供；卸载本插件前，先把用到它的会话切回其他预设",
			"target.sessionSearch": "搜索会话 ID 或目录",
			"target.sessionPaste": "会话 ID",
			"target.sessionPasteHint": "也可以直接粘贴完整会话 ID",
			"target.sessionEmpty": "没有匹配的会话",
			"target.sessionLoading": "读取会话…",
			"target.noWorkspace": "还没有工作区，请填目录",

			"message.text": "用户消息",
			"message.placeholder": "到点后发送的内容，可以直接写 /goal、/技能名 等指令",
			"message.goalMode": "以 /goal 目标方式触发",
			"message.goalHint": "打开后不再发送消息，而是执行 /goal <正文>",
			"message.payloadHint": "正文里的 {{payload}} 会被 Webhook 请求体替换；定时触发时替换为空",

			"webhook.url": "触发地址",
			"webhook.copy": "复制",
			"webhook.copied": "已复制",
			"webhook.rotate": "轮换密钥",
			"webhook.rotateConfirm": "再点一次确认轮换",
			"webhook.hint": "GET 或 POST 这个地址即可触发一次；POST 的正文会替换正文里的 {{payload}}",
			"webhook.needSave": "保存后生成地址",

			"history.empty": "还没有运行记录",
			"history.clear": "清空记录",
			"history.clearConfirm": "再点一次确认清空",
			"history.result.ok": "成功",
			"history.result.failed": "失败",
			"history.result.missed": "已跳过",
			"history.delivered": "会话 {sessionId}",
			"history.failed": "投递失败：{message}",
			"history.skipped": "已跳过 {count} 次 · 最近 {last}",

			"error.load": "加载失败：{message}",
			"error.save": "保存失败：{message}",
			"error.conflict": "这条任务已被修改，请返回列表重新打开",
			"error.offline": "无法连接宿主",

			"time.justNow": "即将",
			"time.inMinutes": "{n} 分钟后",
			"time.inHours": "{n} 小时后",
			"time.inDays": "{n} 天后",
			"time.minutesAgo": "{n} 分钟前",
			"time.hoursAgo": "{n} 小时前",
			"time.daysAgo": "{n} 天前",
		};

		const en = {
			"tab.title": "Tasks",
			"guide.title": "Task Center",
			"guide.description": "Scheduled and webhook tasks",

			"panel.new": "New task",
			"panel.search": "Search tasks",
			"panel.refresh": "Refresh",
			"panel.loading": "Loading…",
			"panel.empty": "No tasks yet",
			"panel.emptyHint": "Use “New task” in the top right to create one",
			"panel.emptyFiltered": "Nothing matches these filters",
			"panel.retry": "Retry",

			"filter.all": "All",
			"filter.enabled": "Enabled",
			"filter.disabled": "Disabled",
			"filter.attention": "Needs attention",

			"status.active": "Enabled",
			"status.inactive": "Disabled",
			"status.attention": "Needs attention",
			"list.next": "Next",
			"list.never": "Never",

			"detail.back": "Back",
			"detail.save": "Save",
			"detail.saving": "Saving…",
			"detail.cancel": "Cancel",
			"detail.delete": "Delete task",
			"detail.deleteConfirm": "Click again to delete",
			"detail.newTitle": "New task",

			"section.basic": "Basics",
			"section.trigger": "Trigger",
			"section.delivery": "Delivery",
			"section.webhook": "Webhook",
			"section.history": "Run history",

			"field.name": "Task name",
			"field.namePlaceholder": "e.g. Nightly code review",
			"field.enabled": "Enabled",
			"field.enabledHint": "A disabled task keeps its settings and history but never fires",

			"trigger.kind": "Trigger",
			"trigger.at": "Once at a set time",
			"trigger.every": "Fixed interval",
			"trigger.daily": "Daily",
			"trigger.weekly": "Weekly",
			"trigger.cron": "Cron expression",
			"trigger.webhook": "Webhook",
			"trigger.atLabel": "Fire at",
			"trigger.everyValue": "Every",
			"trigger.unit.minutes": "minutes",
			"trigger.unit.hours": "hours",
			"trigger.time": "Time",
			"trigger.zone": "Time zone",
			"trigger.weekdays": "Weekdays",
			"trigger.cronLabel": "Expression",
			"trigger.cronHint": "Five fields: minute hour day month weekday, e.g. 0 9 * * 1-5",
			"trigger.preview": "Next 5 runs",
			"trigger.previewEmpty": "Cannot compute the next run; check the expression and zone",

			"summary.once": "Once at {at}",
			"summary.everyMinutes": "Every {n} min",
			"summary.everyHours": "Every {n} h",
			"summary.daily": "Daily {time} · {zone}",
			"summary.weekly": "Weekly {days} {time} · {zone}",
			"summary.session": "Session {label}",
			"summary.newSession": "New session · {where}",

			"weekday.1": "Mon",
			"weekday.2": "Tue",
			"weekday.3": "Wed",
			"weekday.4": "Thu",
			"weekday.5": "Fri",
			"weekday.6": "Sat",
			"weekday.7": "Sun",

			"target.kind": "Deliver to",
			"target.newSession": "New session",
			"target.session": "Existing session",
			"target.workspace": "Workspace",
			"target.cwd": "Directory",
			"target.preset": "Preset",
			"target.presetHint": "「任务管理」comes from this plugin; switch any session using it to another preset before uninstalling",
			"target.sessionSearch": "Search session id or directory",
			"target.sessionPaste": "Session id",
			"target.sessionPasteHint": "You can also paste a full session id",
			"target.sessionEmpty": "No matching sessions",
			"target.sessionLoading": "Reading sessions…",
			"target.noWorkspace": "No workspaces yet — enter a directory",

			"message.text": "User message",
			"message.placeholder": "What to send when the task fires; /goal and /skill-name commands work here",
			"message.goalMode": "Run as a /goal objective",
			"message.goalHint": "Runs /goal <body> instead of sending the body as a message",
			"message.payloadHint": "{{payload}} is replaced by a webhook request body, and by nothing on a timed run",

			"webhook.url": "Trigger URL",
			"webhook.copy": "Copy",
			"webhook.copied": "Copied",
			"webhook.rotate": "Rotate secret",
			"webhook.rotateConfirm": "Click again to rotate",
			"webhook.hint": "GET or POST this URL to fire once; a POST body replaces {{payload}}",
			"webhook.needSave": "Save the task to get a URL",

			"history.empty": "No runs yet",
			"history.clear": "Clear history",
			"history.clearConfirm": "Click again to clear",
			"history.result.ok": "Delivered",
			"history.result.failed": "Failed",
			"history.result.missed": "Skipped",
			"history.delivered": "Session {sessionId}",
			"history.failed": "Delivery failed: {message}",
			"history.skipped": "Skipped {count} run(s) · last {last}",

			"error.load": "Cannot load: {message}",
			"error.save": "Cannot save: {message}",
			"error.conflict": "This task changed elsewhere; go back and open it again",
			"error.offline": "The Host is unreachable",

			"time.justNow": "any moment",
			"time.inMinutes": "in {n} min",
			"time.inHours": "in {n} h",
			"time.inDays": "in {n} d",
			"time.minutesAgo": "{n} min ago",
			"time.hoursAgo": "{n} h ago",
			"time.daysAgo": "{n} d ago",
		};

		/* ================================================================ */
		/* styles                                                            */
		/* ================================================================ */

		const CSS = `
.tc-root{display:flex;flex-direction:column;min-height:0;height:100%;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);}
.tc-root *{box-sizing:border-box;}
.tc-head{display:flex;flex-direction:column;gap:8px;padding:10px 12px 8px;border-bottom:1px solid var(--dsw-alias-border-l3);flex:none;}
.tc-head-row{display:flex;align-items:center;gap:8px;}
.tc-head-title{margin:0;font-size:14px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.tc-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;border:1px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-md);padding:4px 10px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;transition:background .12s ease;}
.tc-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}
.tc-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}
.tc-btn[disabled]{opacity:.5;cursor:not-allowed;}
.tc-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted);}
.tc-btn-primary:hover{background:var(--dsw-alias-button-primary-hover);}
.tc-btn-ghost{border-color:transparent;}
.tc-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-border-l3);}
.tc-btn-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger);}
.tc-search{width:100%;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);color:inherit;border-radius:var(--dsw-radius-md);padding:5px 9px;font:inherit;font-size:12px;}
.tc-search:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary);}
.tc-chips{display:flex;flex-wrap:wrap;gap:6px;}
.tc-chip{border:1px solid transparent;background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 10px;font:inherit;font-size:11px;cursor:pointer;}
.tc-chip[aria-pressed="true"]{background:var(--dsw-alias-button-primary-dimmed);color:var(--dsw-alias-label-primary);}
.tc-body{flex:1;min-height:0;overflow:auto;}
.tc-list{display:flex;flex-direction:column;}
.tc-row{display:flex;gap:10px;align-items:flex-start;width:100%;text-align:left;background:transparent;border:0;border-bottom:1px solid var(--dsw-alias-border-l4);padding:10px 12px;font:inherit;color:inherit;cursor:pointer;}
.tc-row:hover{background:var(--dsw-alias-interactive-bg-hover);}
.tc-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}
.tc-dot{flex:none;width:8px;height:8px;border-radius:50%;margin-top:6px;background:var(--dsw-alias-label-tertiary);}
.tc-dot-active{background:var(--dsw-alias-state-success-primary);}
.tc-dot-attention{background:var(--dsw-alias-state-error-primary);}
.tc-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}
.tc-row-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.tc-row-meta{color:var(--dsw-alias-label-secondary);font-size:11.5px;display:flex;flex-wrap:wrap;gap:4px 10px;}
.tc-row-when{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;text-align:right;white-space:nowrap;}
.tc-empty{padding:36px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);}
.tc-empty strong{display:block;color:var(--dsw-alias-label-secondary);font-weight:500;margin-bottom:4px;}
.tc-error{margin:10px 12px;padding:8px 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-state-error-primary);font-size:12px;}
.tc-detail{display:flex;flex-direction:column;gap:0;padding-bottom:12px;}
.tc-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l3);position:sticky;top:0;background:var(--dsw-alias-bg-base);z-index:2;}
.tc-bar-title{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.tc-section{border-bottom:1px solid var(--dsw-alias-border-l4);}
.tc-section-head{display:flex;align-items:center;gap:8px;width:100%;background:transparent;border:0;padding:10px 12px;font:inherit;font-weight:600;color:inherit;cursor:pointer;text-align:left;}
.tc-section-head:hover{background:var(--dsw-alias-interactive-bg-hover);}
.tc-section-caret{color:var(--dsw-alias-label-tertiary);transition:transform .12s ease;font-size:10px;}
.tc-section[data-open="true"] .tc-section-caret{transform:rotate(90deg);}
.tc-section-note{margin-left:auto;font-weight:400;font-size:11px;color:var(--dsw-alias-label-tertiary);}
.tc-section-body{display:flex;flex-direction:column;gap:10px;padding:0 12px 12px;}
.tc-field{display:flex;flex-direction:column;gap:4px;min-width:0;}
.tc-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);}
.tc-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);}
.tc-input,.tc-select,.tc-textarea{width:100%;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);color:inherit;border-radius:var(--dsw-radius-md);padding:5px 9px;font:inherit;font-size:12.5px;}
.tc-input:focus-visible,.tc-select:focus-visible,.tc-textarea:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary);}
.tc-textarea{min-height:88px;resize:vertical;line-height:1.55;}
.tc-select{appearance:auto;}
.tc-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.tc-inline > .tc-input,.tc-inline > .tc-select{flex:1 1 96px;min-width:0;}
.tc-switch{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12.5px;}
.tc-switch input{appearance:none;width:32px;height:18px;border-radius:999px;background:var(--dsw-alias-fill-l2);position:relative;cursor:pointer;transition:background .15s ease;flex:none;margin:0;}
.tc-switch input::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .15s ease;}
.tc-switch input:checked{background:var(--dsw-alias-brand-primary);}
.tc-switch input:checked::after{transform:translateX(14px);}
.tc-days{display:flex;gap:4px;flex-wrap:wrap;}
.tc-day{min-width:34px;text-align:center;border:1px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);padding:3px 6px;font:inherit;font-size:11.5px;cursor:pointer;}
.tc-day[aria-pressed="true"]{background:var(--dsw-alias-button-primary-dimmed);color:var(--dsw-alias-label-primary);border-color:transparent;}
.tc-preview{display:flex;flex-direction:column;gap:2px;font-size:11.5px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-l1);border-radius:var(--dsw-radius-md);padding:7px 9px;}
.tc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;}
.tc-url{display:flex;gap:6px;align-items:center;}
.tc-url .tc-input{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;}
.tc-sessions{display:flex;flex-direction:column;max-height:190px;overflow:auto;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);}
.tc-session{display:flex;flex-direction:column;gap:1px;width:100%;text-align:left;background:transparent;border:0;border-bottom:1px solid var(--dsw-alias-border-l4);padding:6px 9px;font:inherit;color:inherit;cursor:pointer;}
.tc-session:last-child{border-bottom:0;}
.tc-session:hover{background:var(--dsw-alias-interactive-bg-hover);}
.tc-session[aria-selected="true"]{background:var(--dsw-alias-button-primary-dimmed);}
.tc-session-top{display:flex;gap:8px;align-items:baseline;}
.tc-session-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;}
.tc-session-when{color:var(--dsw-alias-label-tertiary);font-size:10.5px;white-space:nowrap;}
.tc-session-sub{color:var(--dsw-alias-label-tertiary);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.tc-running{color:var(--dsw-alias-state-success-primary);}
.tc-history{display:flex;flex-direction:column;gap:6px;}
.tc-run{display:flex;gap:8px;align-items:flex-start;font-size:11.5px;}
.tc-badge{flex:none;border-radius:999px;padding:1px 7px;font-size:10.5px;border:1px solid transparent;}
.tc-badge-ok{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-fill-l1);}
.tc-badge-failed{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-fill-l1);}
.tc-badge-missed{color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-fill-l1);}
.tc-run-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;}
.tc-run-text{overflow-wrap:anywhere;}
.tc-run-when{color:var(--dsw-alias-label-tertiary);font-size:10.5px;}
.tc-foot{display:flex;gap:8px;align-items:center;padding:4px 12px 0;}
.tc-foot .tc-btn{flex:none;}
.tc-spacer{flex:1;}
.tc-guide-icon{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;}
.tc-tab-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
@media (max-width:420px){
.tc-row-when{display:none;}
.tc-inline{flex-direction:column;align-items:stretch;}
}
`;

		/**
		 * Install the stylesheet once and remove it when the last user leaves.
		 * The tag carries the module id so the shell can evict it with the bundle.
		 * @returns {() => void} the release function.
		 */
		function mountCss() {
			if (typeof document === "undefined") return () => {};
			let tag = document.querySelector('style[data-plugin-css="' + CSS_TAG + '"]');
			if (!tag) {
				tag = document.createElement("style");
				tag.dataset.pluginCss = CSS_TAG;
				tag.dataset.plugin = "@ds-hu/dsh-auto-task-center";
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}
			return () => {
				if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
			};
		}

		/* ================================================================ */
		/* icons                                                             */
		/* ================================================================ */

		function TaskGlyph(props) {
			const size = (props && props.size) || 16;
			return h("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.7,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
			},
			h("rect", { x: 3, y: 4, width: 13, height: 16, rx: 3 }),
			h("path", { d: "M6.5 9.5h6M6.5 13h4" }),
			h("path", { d: "M6.8 16.2l1.6 1.6 3-3.2" }),
			h("circle", { cx: 17.5, cy: 16.5, r: 4.5 }),
			h("path", { d: "M17.5 14.3v2.4l1.7 1.1" }));
		}

		/* ================================================================ */
		/* primitive controls                                                */
		/* ================================================================ */

		function Field(props) {
			return h("div", { className: "tc-field" },
				props.label ? h("span", { className: "tc-label" }, props.label) : null,
				props.children,
				props.hint ? h("span", { className: "tc-hint" }, props.hint) : null);
		}

		function TextInput(props) {
			return h("input", {
				className: "tc-input",
				type: props.type || "text",
				value: props.value === undefined || props.value === null ? "" : props.value,
				placeholder: props.placeholder,
				disabled: props.disabled,
				onChange: (event) => props.onChange(event.target.value),
				onBlur: props.onBlur,
			});
		}

		function Select(props) {
			return h("select", {
				className: "tc-select",
				value: props.value === undefined || props.value === null ? "" : props.value,
				disabled: props.disabled,
				onChange: (event) => props.onChange(event.target.value),
			}, props.options.map((option) => h("option", { key: option.value, value: option.value }, option.label)));
		}

		function Switch(props) {
			return h("label", { className: "tc-switch" },
				h("input", {
					type: "checkbox",
					checked: props.checked === true,
					onChange: (event) => props.onChange(event.target.checked),
				}),
				h("span", null, props.label));
		}

		function Section(props) {
			return h("section", { className: "tc-section", "data-open": props.open ? "true" : "false" },
				h("button", {
					type: "button",
					className: "tc-section-head",
					"aria-expanded": props.open ? "true" : "false",
					onClick: props.onToggle,
				},
				h("span", { className: "tc-section-caret", "aria-hidden": "true" }, "▶"),
				h("span", null, props.title),
				props.note ? h("span", { className: "tc-section-note" }, props.note) : null),
				props.open ? h("div", { className: "tc-section-body" }, props.children) : null);
		}

		/* ================================================================ */
		/* session picker                                                    */
		/* ================================================================ */

		/**
		 * Session rows from the shell's own catalog.
		 *
		 * The Host list endpoint re-summarizes every session directory and can take
		 * tens of seconds on a large profile, while the browser already holds the same
		 * rows for its sidebar — with display titles. Reading them keeps the picker
		 * instant and consistent with the session tree the reader just used.
		 *
		 * @returns {{ sessionId: string, label: string, cwd: string, updatedAt: number, running: boolean }[]|null}
		 *   rows, or null when the shell exposes no session catalog.
		 */
		function sessionRowsFromShell() {
			try {
				const service = appCtx !== null && typeof appCtx.get === "function" ? appCtx.get("sessions") : undefined;
				const list = service ? service.list : undefined;
				const snapshot = list && typeof list.getSnapshot === "function" ? list.getSnapshot() : undefined;
				if (!snapshot || !snapshot.byId) return null;
				const rows = [];
				for (const key of Object.keys(snapshot.byId)) {
					const row = snapshot.byId[key];
					if (!row || row.origin === "subagent") continue;
					rows.push({
						sessionId: row.id || key,
						label: row.displayTitle || row.title || "",
						cwd: row.cwd || "",
						updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
						running: row.running === true,
					});
				}
				rows.sort((left, right) => right.updatedAt - left.updatedAt);
				return rows;
			} catch {
				return null;
			}
		}

		/** Last successful Host listing, kept across panel mounts. */
		const sessionCache = { rows: null };

		/**
		 * Whether a session row matches the picker query.
		 * @param {object} row - one row.
		 * @param {string} query - lower-cased needle.
		 * @returns {boolean} the answer.
		 */
		function sessionMatches(row, query) {
			if (query === "") return true;
			return row.sessionId.toLowerCase().includes(query)
				|| row.cwd.toLowerCase().includes(query)
				|| row.label.toLowerCase().includes(query);
		}

		function SessionPicker(props) {
			const [query, setQuery] = useState("");
			const [remote, setRemote] = useState(sessionCache.rows);
			const [error, setError] = useState(null);
			const timer = useRef(null);
			const shellRows = sessionRowsFromShell();
			const needsHost = shellRows === null;

			useEffect(() => {
				if (!needsHost) return undefined;
				let cancelled = false;
				if (timer.current) clearTimeout(timer.current);
				timer.current = setTimeout(() => {
					apiGet("/sessions?limit=50&q=" + encodeURIComponent(query))
						.then((value) => {
							if (cancelled) return;
							setRemote(value.items || []);
							if (query === "") sessionCache.rows = value.items || [];
							setError(null);
						})
						.catch((failure) => {
							if (cancelled) return;
							setRemote([]);
							setError(failure.message);
						});
				}, query === "" ? 0 : 250);
				return () => {
					cancelled = true;
					if (timer.current) clearTimeout(timer.current);
				};
			}, [query, needsHost]);

			const needle = query.trim().toLowerCase();
			const all = shellRows === null ? remote : shellRows;
			const rows = all === null ? null : all.filter((row) => sessionMatches(row, needle)).slice(0, 50);
			const manual = props.value && rows !== null && !rows.some((row) => row.sessionId === props.value);
			return h(react.Fragment, null,
				h(Field, { label: t("target.sessionSearch") },
					h(TextInput, { value: query, onChange: setQuery, placeholder: t("target.sessionSearch") })),
				h("div", { className: "tc-sessions", role: "listbox" },
					rows === null
						? h("div", { className: "tc-empty" }, t("target.sessionLoading"))
						: rows.length === 0
							? h("div", { className: "tc-empty" }, error || t("target.sessionEmpty"))
							: rows.map((row) => h("button", {
								key: row.sessionId,
								type: "button",
								role: "option",
								className: "tc-session",
								"aria-selected": row.sessionId === props.value ? "true" : "false",
								onClick: () => props.onChange(row.sessionId),
							},
							h("span", { className: "tc-session-top" },
								h("span", { className: "tc-session-name" }, row.label || basename(row.cwd) || String(row.sessionId).replace(/^session-/u, "").slice(0, 8)),
								row.running ? h("span", { className: "tc-session-when tc-running" }, "●") : null,
								h("span", { className: "tc-session-when" }, formatRelative(row.updatedAt))),
							h("span", { className: "tc-session-sub" }, row.cwd || String(row.sessionId)))),
					manual ? h("div", { className: "tc-session", "aria-selected": "true" },
						h("span", { className: "tc-session-top" },
							h("span", { className: "tc-session-name" }, t("target.sessionPaste")),
							h("span", { className: "tc-session-when" }, "✓")),
						h("span", { className: "tc-session-sub" }, String(props.value))) : null),
				h(Field, { label: t("target.sessionPaste"), hint: t("target.sessionPasteHint") },
					h(TextInput, { value: props.value || "", onChange: props.onChange, placeholder: "session id" })));
		}

		/* ================================================================ */
		/* trigger editor                                                    */
		/* ================================================================ */

		const TRIGGER_OPTIONS = [
			{ value: "at", label: "trigger.at" },
			{ value: "every", label: "trigger.every" },
			{ value: "daily", label: "trigger.daily" },
			{ value: "weekly", label: "trigger.weekly" },
			{ value: "cron", label: "trigger.cron" },
			{ value: "webhook", label: "trigger.webhook" },
		];

		function defaultTriggerFor(kind, previous) {
			const zone = (previous && previous.timeZone) || browserZone();
			const time = (previous && previous.time) || "09:00:00";
			switch (kind) {
				case "at": {
					const at = new Date(Date.now() + 3600000);
					at.setSeconds(0, 0);
					return { kind: "at", at: at.toISOString() };
				}
				case "every": return { kind: "every", everySeconds: 3600 };
				case "daily": return { kind: "daily", time, timeZone: zone };
				case "weekly": return { kind: "weekly", time, timeZone: zone, weekdays: [1] };
				case "cron": return { kind: "cron", expression: "0 9 * * 1-5", timeZone: zone };
				case "webhook": return { kind: "webhook" };
				default: return { kind: "daily", time, timeZone: zone };
			}
		}

		function TriggerEditor(props) {
			const trigger = props.value;
			const [preview, setPreview] = useState(null);
			const [previewError, setPreviewError] = useState(null);
			const patch = (changes) => props.onChange({ ...trigger, ...changes });

			const key = JSON.stringify(trigger);
			useEffect(() => {
				let cancelled = false;
				if (trigger.kind === "webhook") {
					setPreview(null);
					setPreviewError(null);
					return () => { cancelled = true; };
				}
				const timer = setTimeout(() => {
					apiPost("/preview", { trigger })
						.then((value) => {
							if (cancelled) return;
							setPreview(value.next || []);
							setPreviewError(null);
						})
						.catch((failure) => {
							if (cancelled) return;
							setPreview([]);
							setPreviewError(failure.message);
						});
				}, 350);
				return () => {
					cancelled = true;
					clearTimeout(timer);
				};
			}, [key]);

			const zones = useMemo(() => timezoneOptions(trigger.timeZone), [trigger.timeZone]);
			const everyMinutes = trigger.kind === "every"
				? (trigger.everySeconds % 3600 === 0 ? trigger.everySeconds / 60 : trigger.everySeconds)
				: 0;
			const everyUnit = trigger.kind === "every" && trigger.everySeconds % 3600 === 0 ? "hours" : "minutes";

			const controls = [];
			if (trigger.kind === "at") {
				controls.push(h(Field, { key: "at", label: t("trigger.atLabel") },
					h("input", {
						className: "tc-input",
						type: "datetime-local",
						value: toLocalInput(trigger.at),
						onChange: (event) => {
							const iso = fromLocalInput(event.target.value);
							if (iso !== undefined) patch({ at: iso });
						},
					})));
			}
			if (trigger.kind === "every") {
				controls.push(h(Field, { key: "every", label: t("trigger.everyValue") },
					h("div", { className: "tc-inline" },
						h(TextInput, {
							type: "number",
							value: everyMinutes,
							onChange: (text) => {
								const n = Number(text);
								if (!Number.isFinite(n) || n <= 0) return;
								patch({ everySeconds: Math.round(everyUnit === "hours" ? n * 3600 : n * 60) });
							},
						}),
						h(Select, {
							value: everyUnit,
							options: [
								{ value: "minutes", label: t("trigger.unit.minutes") },
								{ value: "hours", label: t("trigger.unit.hours") },
							],
							onChange: (unit) => {
								const n = Math.max(1, everyMinutes);
								patch({ everySeconds: Math.round(unit === "hours" ? n * 3600 : n * 60) });
							},
						}))));
			}
			if (trigger.kind === "daily" || trigger.kind === "weekly") {
				controls.push(h(Field, { key: "time", label: t("trigger.time") },
					h("input", {
						className: "tc-input",
						type: "time",
						value: (trigger.time || "09:00:00").slice(0, 5),
						onChange: (event) => patch({ time: event.target.value + ":00" }),
					})));
			}
			if (trigger.kind === "weekly") {
				controls.push(h(Field, { key: "days", label: t("trigger.weekdays") },
					h("div", { className: "tc-days" }, [1, 2, 3, 4, 5, 6, 7].map((day) => h("button", {
						key: day,
						type: "button",
						className: "tc-day",
						"aria-pressed": trigger.weekdays.indexOf(day) >= 0 ? "true" : "false",
						onClick: () => {
							const has = trigger.weekdays.indexOf(day) >= 0;
							const next = has ? trigger.weekdays.filter((value) => value !== day) : trigger.weekdays.concat([day]).sort();
							if (next.length === 0) return;
							patch({ weekdays: next });
						},
					}, t("weekday." + day))))));
			}
			if (trigger.kind === "daily" || trigger.kind === "weekly" || trigger.kind === "cron") {
				controls.push(h(Field, { key: "zone", label: t("trigger.zone") },
					h(Select, {
						value: trigger.timeZone,
						options: zones.map((zone) => ({ value: zone, label: zone })),
						onChange: (zone) => patch({ timeZone: zone }),
					})));
			}
			if (trigger.kind === "cron") {
				controls.push(h(Field, { key: "cron", label: t("trigger.cronLabel"), hint: t("trigger.cronHint") },
					h(TextInput, {
						value: trigger.expression,
						onChange: (expression) => patch({ expression }),
						placeholder: "*/15 9-17 * * 1-5",
					})));
			}
			if (trigger.kind !== "webhook") {
				controls.push(h("div", { key: "preview", className: "tc-preview" },
					h("strong", null, t("trigger.preview")),
					previewError
						? h("span", null, t("trigger.previewEmpty"))
						: preview === null
							? h("span", null, "…")
							: preview.length === 0
								? h("span", null, t("trigger.previewEmpty"))
								: preview.map((iso) => h("span", { key: iso }, formatClock(iso)))));
			}

			return h("div", { className: "tc-field" },
				h(Field, { label: t("trigger.kind") },
					h(Select, {
						value: trigger.kind,
						options: TRIGGER_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) })),
						onChange: (kind) => props.onChange(defaultTriggerFor(kind, trigger)),
					})),
				controls);
		}

		/* ================================================================ */
		/* panel                                                             */
		/* ================================================================ */

		function emptyDraft(state) {
			const workspace = state && state.workspaces && state.workspaces.length > 0 ? state.workspaces[0] : undefined;
			const presets = state && state.presets ? state.presets : [];
			const standard = presets.find((preset) => preset.id === "standard") || presets[0];
			return {
				name: "",
				enabled: true,
				trigger: defaultTriggerFor("daily", undefined),
				target: workspace
					? { kind: "newSession", workspaceId: workspace.id, ...(standard ? { agentPreset: standard.id } : {}) }
					: { kind: "newSession", cwd: "", ...(standard ? { agentPreset: standard.id } : {}) },
				message: { text: "", goalMode: false },
			};
		}

		function draftFrom(task) {
			return {
				name: task.name,
				enabled: task.enabled,
				trigger: task.trigger,
				target: task.target,
				message: task.message,
			};
		}

		function historyText(entry) {
			const params = entry.params || {};
			if (entry.code === "delivered") {
				const raw = String(params.sessionId || entry.sessionId || "").replace(/^session-/u, "");
				return t("history.delivered", { sessionId: raw.slice(0, 8) || "—" });
			}
			if (entry.code === "skipped") {
				return t("history.skipped", { count: params.count || 0, last: params.last ? formatClock(params.last) : "" });
			}
			if (entry.code === "failed") return t("history.failed", { message: params.message || entry.detail || "" });
			return entry.detail || "";
		}

		function TaskList(props) {
			const { rows, query, filter } = props;
			const visible = rows.filter((task) => {
				if (filter === "enabled" && !task.enabled) return false;
				if (filter === "disabled" && task.enabled) return false;
				if (filter === "attention" && !task.state.needsAttention) return false;
				if (query === "") return true;
				const haystack = (task.name + " " + triggerSummary(task.trigger) + " " + targetSummary(task.target, props.state)).toLowerCase();
				return haystack.indexOf(query.toLowerCase()) >= 0;
			});
			if (visible.length === 0) {
				return h("div", { className: "tc-empty" },
					h("strong", null, query !== "" || filter !== "all" ? t("panel.emptyFiltered") : t("panel.empty")),
					query !== "" || filter !== "all" ? null : t("panel.emptyHint"));
			}
			return h("div", { className: "tc-list" }, visible.map((task) => {
				const attention = task.state.needsAttention === true;
				const dotClass = cx("tc-dot", attention ? "tc-dot-attention" : (task.enabled ? "tc-dot-active" : ""));
				return h("button", {
					key: task.id,
					type: "button",
					className: "tc-row",
					onClick: () => props.onOpen(task.id),
				},
				h("span", { className: dotClass, "aria-hidden": "true" }),
				h("span", { className: "tc-row-main" },
					h("span", { className: "tc-row-name" }, task.name),
					h("span", { className: "tc-row-meta" },
						h("span", null, triggerSummary(task.trigger)),
						h("span", null, "·"),
						h("span", null, targetSummary(task.target, props.state)),
						attention ? h("span", { className: "tc-badge tc-badge-failed" }, t("status.attention")) : null)),
				h("span", { className: "tc-row-when" },
					task.state.nextAt ? formatRelative(task.state.nextAt) : (task.enabled ? "" : t("status.inactive"))));
			}));
		}

		function TaskDetail(props) {
			const { draft, task, state } = props;
			const [open, setOpen] = useState({ basic: true, trigger: true, delivery: true, webhook: true, history: false });
			const [confirmDelete, setConfirmDelete] = useState(false);
			const [confirmRotate, setConfirmRotate] = useState(false);
			const [confirmClear, setConfirmClear] = useState(false);
			const [copied, setCopied] = useState(false);

			const set = (changes) => props.onChange({ ...draft, ...changes });
			const toggle = (key) => setOpen({ ...open, [key]: !open[key] });

			const webhookUrl = task && task.trigger.kind === "webhook" && state && state.origin
				? state.origin + "/task-center/hook/" + task.id + "/" + task.trigger.secret
				: null;

			const workspaceOptions = (state.workspaces || []).map((workspace) => ({
				value: workspace.id,
				label: workspace.title + " · " + workspace.path,
			}));
			const presetOptions = (state.presets || []).map((preset) => ({ value: preset.id, label: presetLabel(preset) }));
			if (draft.target.kind === "newSession" && draft.target.agentPreset && !presetOptions.some((option) => option.value === draft.target.agentPreset)) {
				presetOptions.push({ value: draft.target.agentPreset, label: draft.target.agentPreset });
			}

			const targetControls = draft.target.kind === "newSession"
				? [
					workspaceOptions.length > 0
						? h(Field, { key: "ws", label: t("target.workspace") },
							h(Select, {
								value: draft.target.workspaceId || workspaceOptions[0].value,
								options: workspaceOptions,
								onChange: (value) => set({ target: { ...draft.target, workspaceId: value, cwd: undefined } }),
							}))
						: h(Field, { key: "cwd", label: t("target.cwd"), hint: t("target.noWorkspace") },
							h(TextInput, {
								value: draft.target.cwd || "",
								onChange: (value) => set({ target: { ...draft.target, cwd: value, workspaceId: undefined } }),
							})),
					h(Field, { key: "preset", label: t("target.preset"), hint: t("target.presetHint") },
						presetOptions.length > 0
							? h(Select, {
								value: draft.target.agentPreset || "",
								options: [{ value: "", label: "—" }].concat(presetOptions),
								onChange: (value) => set({ target: { ...draft.target, agentPreset: value === "" ? undefined : value } }),
							})
							: h(TextInput, {
								value: draft.target.agentPreset || "",
								onChange: (value) => set({ target: { ...draft.target, agentPreset: value === "" ? undefined : value } }),
								placeholder: "standard",
							})),
				]
				: [h(SessionPicker, {
					key: "session",
					value: draft.target.sessionId || "",
					onChange: (value) => set({ target: { kind: "session", sessionId: value } }),
				})];

			return h("div", { className: "tc-detail" },
				h("div", { className: "tc-bar" },
					h("button", { type: "button", className: "tc-btn tc-btn-ghost", onClick: props.onBack }, "‹ " + t("detail.back")),
					h("span", { className: "tc-bar-title" }, task ? task.name : t("detail.newTitle")),
					task ? h("button", {
						type: "button",
						className: "tc-btn",
						onClick: () => {
							if (confirmDelete) {
								props.onDelete(task.id);
							} else {
								setConfirmDelete(true);
								setTimeout(() => setConfirmDelete(false), 4000);
							}
						},
					}, confirmDelete ? t("detail.deleteConfirm") : t("detail.delete")) : null),

				h(Section, { title: t("section.basic"), open: open.basic, onToggle: () => toggle("basic") },
					h(Field, { label: t("field.name") },
						h(TextInput, {
							value: draft.name,
							placeholder: t("field.namePlaceholder"),
							onChange: (value) => set({ name: value }),
						})),
					h("div", { className: "tc-field" },
						h(Switch, { checked: draft.enabled, onChange: (value) => set({ enabled: value }), label: t("field.enabled") }),
						h("span", { className: "tc-hint" }, t("field.enabledHint")))),

				h(Section, { title: t("section.trigger"), open: open.trigger, onToggle: () => toggle("trigger") },
					h(TriggerEditor, { value: draft.trigger, onChange: (trigger) => set({ trigger }) })),

				h(Section, { title: t("section.delivery"), open: open.delivery, onToggle: () => toggle("delivery") },
					h(Field, { label: t("target.kind") },
						h(Select, {
							value: draft.target.kind,
							options: [
								{ value: "newSession", label: t("target.newSession") },
								{ value: "session", label: t("target.session") },
							],
							onChange: (kind) => set({
								target: kind === "session"
									? { kind: "session", sessionId: draft.target.sessionId || "" }
									: emptyDraft(state).target,
							}),
						})),
					targetControls,
					h(Field, { label: t("message.text"), hint: t("message.payloadHint") },
						h("textarea", {
							className: "tc-textarea",
							value: draft.message.text,
							placeholder: t("message.placeholder"),
							onChange: (event) => set({ message: { ...draft.message, text: event.target.value } }),
						})),
					h("div", { className: "tc-field" },
						h(Switch, {
							checked: draft.message.goalMode,
							onChange: (value) => set({ message: { ...draft.message, goalMode: value } }),
							label: t("message.goalMode"),
						}),
						h("span", { className: "tc-hint" }, t("message.goalHint")))),

				draft.trigger.kind === "webhook"
					? h(Section, { title: t("section.webhook"), open: open.webhook, onToggle: () => toggle("webhook") },
						h(Field, { label: t("webhook.url"), hint: t("webhook.hint") },
							webhookUrl
								? h("div", { className: "tc-url" },
									h("input", { className: "tc-input", readOnly: true, value: webhookUrl, onFocus: (event) => event.target.select() }),
									h("button", {
										type: "button",
										className: "tc-btn",
										onClick: () => {
											const done = () => {
												setCopied(true);
												setTimeout(() => setCopied(false), 1500);
											};
											if (navigator.clipboard && navigator.clipboard.writeText) {
												navigator.clipboard.writeText(webhookUrl).then(done, done);
											} else {
												done();
											}
										},
									}, copied ? t("webhook.copied") : t("webhook.copy")))
								: h("span", { className: "tc-hint" }, t("webhook.needSave"))),
						task ? h("div", { className: "tc-field" },
							h("button", {
								type: "button",
								className: "tc-btn",
								onClick: () => {
									if (confirmRotate) {
										props.onRotate(task.id);
										setConfirmRotate(false);
									} else {
										setConfirmRotate(true);
										setTimeout(() => setConfirmRotate(false), 4000);
									}
								},
							}, confirmRotate ? t("webhook.rotateConfirm") : t("webhook.rotate"))) : null)
					: null,

				task
					? h(Section, {
						title: t("section.history"),
						open: open.history,
						onToggle: () => toggle("history"),
						note: String(task.history.length),
					},
					task.history.length === 0
						? h("div", { className: "tc-hint" }, t("history.empty"))
						: h("div", { className: "tc-history" }, task.history.map((entry) => h("div", { key: entry.runId, className: "tc-run" },
							h("span", { className: "tc-badge tc-badge-" + entry.result }, t("history.result." + entry.result)),
							h("span", { className: "tc-run-body" },
								h("span", { className: "tc-run-text" }, historyText(entry)),
								h("span", { className: "tc-run-when" }, formatClock(entry.at)))))),
					task.history.length > 0
						? h("div", { className: "tc-foot" },
							h("button", {
								type: "button",
								className: "tc-btn",
								onClick: () => {
									if (confirmClear) {
										props.onClearHistory(task.id);
										setConfirmClear(false);
									} else {
										setConfirmClear(true);
										setTimeout(() => setConfirmClear(false), 4000);
									}
								},
							}, confirmClear ? t("history.clearConfirm") : t("history.clear")))
						: null)
					: null,

				h("div", { className: "tc-foot" },
					h("button", { type: "button", className: "tc-btn tc-btn-primary", disabled: props.saving, onClick: props.onSave },
						props.saving ? t("detail.saving") : t("detail.save")),
					h("button", { type: "button", className: "tc-btn", onClick: props.onBack }, t("detail.cancel")),
					h("span", { className: "tc-spacer" }),
					props.error ? h("span", { className: "tc-hint" }, props.error) : null));
		}

		function TaskCenter(props) {
			const [state, setState] = useState(null);
			const [status, setStatus] = useState("loading");
			const [errorText, setErrorText] = useState(null);
			const [query, setQuery] = useState("");
			const [filter, setFilter] = useState("all");
			const [route, setRoute] = useState({ kind: "list" });
			const [draft, setDraft] = useState(null);
			const [saving, setSaving] = useState(false);
			const [saveError, setSaveError] = useState(null);

			const load = useCallback(() => {
				return apiGet("/state")
					.then((value) => {
						setState(value);
						setStatus("ready");
						setErrorText(null);
						return value;
					})
					.catch((failure) => {
						setStatus("error");
						setErrorText(failure.message);
						return null;
					});
			}, []);

			useEffect(() => {
				if (!props.visible) return;
				load();
				// Warm the session picker, but only when the shell exposes no catalog
				// to read: the Host listing costs seconds on a large profile.
				if (sessionCache.rows === null && sessionRowsFromShell() === null) {
					apiGet("/sessions?limit=50&q=")
						.then((value) => {
							sessionCache.rows = value.items || [];
						})
						.catch(() => {
							/* the picker reports its own failure when it asks */
						});
				}
			}, [props.visible, load]);

			useEffect(() => {
				if (!props.visible) return undefined;
				const handle = setInterval(load, 20000);
				return () => clearInterval(handle);
			}, [props.visible, load]);

			const task = route.kind === "detail" && state
				? state.tasks.find((item) => item.id === route.id)
				: undefined;

			useEffect(() => {
				if (route.kind === "detail" && state && task === undefined) {
					setRoute({ kind: "list" });
					setDraft(null);
				}
			}, [route, state, task]);

			const openNew = () => {
				setDraft(emptyDraft(state));
				setRoute({ kind: "new" });
				setSaveError(null);
			};

			const openTask = (id) => {
				const found = state.tasks.find((item) => item.id === id);
				if (!found) return;
				setDraft(draftFrom(found));
				setRoute({ kind: "detail", id });
				setSaveError(null);
			};

			const back = () => {
				setRoute({ kind: "list" });
				setDraft(null);
				setSaveError(null);
			};

			const save = () => {
				if (draft === null || saving) return;
				setSaving(true);
				setSaveError(null);
				const request = route.kind === "detail"
					? apiPost("/tasks/" + encodeURIComponent(route.id), { task: draft, expectedUpdatedAt: task ? task.updatedAt : undefined })
					: apiPost("/tasks", draft);
				request
					.then(() => load())
					.then(() => {
						setSaving(false);
						setRoute({ kind: "list" });
						setDraft(null);
					})
					.catch((failure) => {
						setSaving(false);
						setSaveError(failure.status === 409 ? t("error.conflict") : t("error.save", { message: failure.message }));
					});
			};

			const runAction = (path, onDone) => {
				apiPost(path)
					.then(() => load())
					.then(() => {
						if (onDone) onDone();
					})
					.catch((failure) => setSaveError(t("error.save", { message: failure.message })));
			};

			const head = h("div", { className: "tc-head" },
				h("div", { className: "tc-head-row" },
					h("h2", { className: "tc-head-title" }, t("guide.title")),
					h("button", { type: "button", className: "tc-btn tc-btn-primary", onClick: openNew }, t("panel.new"))),
				h("input", {
					className: "tc-search",
					value: query,
					placeholder: t("panel.search"),
					onChange: (event) => setQuery(event.target.value),
				}),
				h("div", { className: "tc-chips" }, [
					["all", "filter.all"],
					["enabled", "filter.enabled"],
					["disabled", "filter.disabled"],
					["attention", "filter.attention"],
				].map(([value, key]) => h("button", {
					key: value,
					type: "button",
					className: "tc-chip",
					"aria-pressed": filter === value ? "true" : "false",
					onClick: () => setFilter(value),
				}, t(key)))));

			if (route.kind === "list") {
				let body;
				if (status === "loading") body = h("div", { className: "tc-empty" }, t("panel.loading"));
				else if (status === "error") {
					body = h("div", null,
						h("div", { className: "tc-error" }, t("error.load", { message: errorText || t("error.offline") })),
						h("div", { className: "tc-foot" }, h("button", { type: "button", className: "tc-btn", onClick: load }, t("panel.retry"))));
				} else {
					body = h(TaskList, {
						rows: state.tasks,
						state,
						query,
						filter,
						onOpen: openTask,
					});
				}
				return h("div", { className: "tc-root" }, head, h("div", { className: "tc-body" }, body));
			}

			if (draft === null) return h("div", { className: "tc-root" }, head);
			return h("div", { className: "tc-root" },
				h("div", { className: "tc-body" },
					h(TaskDetail, {
						draft,
						task,
						state,
						saving,
						error: saveError,
						onChange: setDraft,
						onBack: back,
						onSave: save,
						onDelete: (id) => runAction("/tasks/" + encodeURIComponent(id) + "/delete", back),
						onRotate: (id) => runAction("/tasks/" + encodeURIComponent(id) + "/rotate-secret", () => {
							apiGet("/state").then((value) => {
								setState(value);
								const refreshed = value.tasks.find((item) => item.id === id);
								if (refreshed) setDraft(draftFrom(refreshed));
							});
						}),
						onClearHistory: (id) => runAction("/tasks/" + encodeURIComponent(id) + "/clear-history", () => {
							apiGet("/state").then((value) => {
								setState(value);
								const refreshed = value.tasks.find((item) => item.id === id);
								if (refreshed) setDraft(draftFrom(refreshed));
							});
						}),
					})));
		}

		/* ================================================================ */
		/* slot components                                                   */
		/* ================================================================ */

		function PanelBody(props) {
			const info = props.useTabInfo();
			const visible = info.tab.visible === true;
			const sessionId = props.sessionId;
			const tabId = info.tab.id;
			useEffect(() => {
				openTabs.set(sessionId, tabId);
				return () => {
					openTabs.delete(sessionId);
				};
			}, [sessionId, tabId]);
			return h(TaskCenter, { visible });
		}

		function PanelTitle(props) {
			const info = props.useTabInfo();
			// A single element, not a fragment: the shell measures this node to size
			// the tab, so it has to carry the intrinsic width itself.
			return h("span", { className: "tc-tab-label" }, info.tab.title || t("tab.title"));
		}

		function tabDefinition() {
			return {
				id: TAB_ID,
				kind: TAB_KIND,
				priority: "extension",
				title: () => t("tab.title"),
				guide: [{
					id: "tasks",
					order: 30,
					title: () => t("guide.title"),
					description: () => t("guide.description"),
					icon: TaskGlyph,
				}],
			};
		}

		/* ================================================================ */
		/* plugin                                                            */
		/* ================================================================ */

		/**
		 * Release this plugin's own right-sidebar tabs.
		 *
		 * Only the tabs this page actually opened can be closed, but those are
		 * exactly the ones the shell persisted, so disabling the plugin leaves
		 * no "nothing can view this" tab behind.
		 * @returns {void}
		 */
		function closeOwnTabs() {
			const sidebar = appCtx && appCtx.get ? appCtx.get("sidebarRight") : undefined;
			if (!sidebar || openTabs.size === 0) return;
			for (const [sessionId, tabId] of Array.from(openTabs.entries())) {
				try {
					if (typeof sidebar.closeIn === "function") sidebar.closeIn(sessionId, tabId);
					else if (typeof sidebar.close === "function") sidebar.close(tabId);
				} catch {
					/* the shell may already have torn the session down */
				}
			}
			openTabs.clear();
		}

		/**
		 * Swap the module-level runtime for tests.
		 * @param {any} ctx - Fake context with a `locale` service.
		 * @param {(key: string, params?: object) => string} translate - Translate function.
		 * @returns {() => void} restores the previous runtime.
		 */
		function setTestRuntime(ctx, translate) {
			const previous = { ctx: appCtx, translate: tt };
			appCtx = ctx;
			tt = translate;
			return () => {
				appCtx = previous.ctx;
				tt = previous.translate;
			};
		}

		function apply(ctx) {
			appCtx = ctx;
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "task-center: dictionaries");
			tt = ctx.locale.bind(NS);
			ctx.effect(() => mountCss(), "task-center: stylesheet");
			ctx.effect(() => closeOwnTabs, "task-center: close own tabs");

			ctx.inject(["sidebarRightTabs"], (sidebarCtx) => {
				sidebarCtx.effect(
					() => sidebarCtx.sidebarRightTabs.register(tabDefinition()),
					"task-center: tab type",
				);
				sidebarCtx.slots.inject("sidebar.right.pane.tab", () => sidebarCtx.slots.register({
					name: "sidebar.right.pane.tab",
					key: TAB_ID,
					locale: NS,
				}, PanelBody));
				sidebarCtx.slots.inject("sidebar.right.pane.tab.title", () => sidebarCtx.slots.register({
					name: "sidebar.right.pane.tab.title",
					key: TAB_ID,
					locale: NS,
				}, PanelTitle));
			});
		}

		exports.name = "task-center-client";
		exports.inject = ["slots", "locale"];
		exports.apply = apply;
		exports.__tcTest = { TaskCenter, PanelBody, PanelTitle, tabDefinition, mountCss, CSS, zh, en, defaultTriggerFor, triggerSummary, formatRelative, toLocalInput, fromLocalInput, setTestRuntime };
		return module.exports;

	}
});
