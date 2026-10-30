/**
 * dsh-cc-auto-memory — Client half.
 *
 * Registers the "Auto Memory" page inside Settings (`settings.section` slot):
 * a storage-mode switcher (card selection + explicit apply), a project picker
 * scoped to the active mode's root, and a read-only memory list — clicking a
 * row opens a floating card with the file's plain-text content. Editing and
 * deleting are intentionally left to the agent during sessions; the panel is a
 * viewer. All data goes through the Host half's fenced HTTP API on
 * `/auto-memory/api/*`.
 */
window.__ModuleLoader__.load({
	id: 'dsh-cc-auto-memory',
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		const { useState, useEffect, useCallback, useMemo, useRef } = React;

		const API = '/auto-memory/api';

		async function api(method, body, signal) {
			// Bound every call: a hung request would otherwise disable the whole page.
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 20000);
			// Optional caller signal (viewer close/unmount) aborts the same controller.
			if (signal) {
				if (signal.aborted) controller.abort();
				else signal.addEventListener('abort', () => controller.abort(), { once: true });
			}
			let response;
			try {
				response = await fetch(`${API}/${method}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body ?? {}),
					signal: controller.signal,
				});
			} catch (error) {
				if (error && error.name === 'AbortError') {
					// Caller-initiated aborts propagate untouched; timeout aborts become a timeout error.
					if (signal && signal.aborted) throw error;
					throw new Error(`request ${method} timed out`);
				}
				throw error;
			} finally {
				clearTimeout(timer);
			}
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				/* fall through to status error */
			}
			if (!response.ok || payload === null || payload.ok !== true) {
				const message = payload && payload.error && payload.error.message ? payload.error.message : `HTTP ${response.status}`;
				throw new Error(message);
			}
			return payload.data;
		}

		const STRINGS = {
			zh: {
				title: 'Auto Memory',
				subtitle: '兼容 Claude Code 的持久化文件记忆：MEMORY.md 索引 + 主题文件，宿主自动注入。',
				modeTitle: '存储模式',
				modeCurrent: '当前',
				modeDshTitle: 'DSH 独立目录',
				modeDshDesc: '记忆保存在 DSH 自己的数据目录，由 DSH 独立积累。',
				modeClaudeTitle: '复用 Claude Code',
				modeClaudeDesc: '与 Claude Code 共享同一份记忆目录，两边互通、格式一致。',
				modeApply: '应用切换',
				modeApplied: '已切换存储模式，对新会话生效。',
				modeHint: '选择新模式后点击「应用切换」；切换只影响新会话。',
				modeSandboxHint: 'claude 模式下，模型写 ~/.claude 目录可能触发沙箱审批，属预期行为。',
				projectTitle: '项目',
				projectCurrent: '当前会话项目',
				projectDir: '记忆目录',
				memoryColumn: '记忆',
				descriptionColumn: '描述',
				indexDesc: '索引文件：每行一条「标题 — 摘要」',
				refresh: '刷新',
				close: '关闭',
				loading: '加载中…',
				clickRowHint: '点击行查看记忆内容',
				empty: '该项目还没有记忆文件。让模型在会话中自己记录即可。',
				noProjects: '当前模式目录下还没有任何项目的记忆。打开一个会话后，其项目的记忆目录会自动创建。',
				emptyDesc: '（无描述）',
			},
			en: {
				title: 'Auto Memory',
				subtitle: 'Claude Code-compatible persistent file memory: MEMORY.md index + topic files, host-injected.',
				modeTitle: 'Storage mode',
				modeCurrent: 'current',
				modeDshTitle: 'DSH-owned directory',
				modeDshDesc: 'Memories live in the DSH data directory and accumulate independently.',
				modeClaudeTitle: 'Share Claude Code',
				modeClaudeDesc: 'Shares the same memory directory with Claude Code — interoperable, identical format.',
				modeApply: 'Apply switch',
				modeApplied: 'Storage mode switched; applies to new sessions.',
				modeHint: 'Pick the new mode, then press Apply. The switch affects new sessions only.',
				modeSandboxHint: 'In claude mode, model writes under ~/.claude may hit sandbox approvals — expected.',
				projectTitle: 'Project',
				projectCurrent: 'current session project',
				projectDir: 'memory directory',
				memoryColumn: 'Memory',
				descriptionColumn: 'Description',
				indexDesc: 'index file: one "title — summary" per line',
				refresh: 'Refresh',
				close: 'Close',
				loading: 'Loading…',
				clickRowHint: 'click a row to view the memory',
				empty: 'No memories in this project yet. Let the model save memories itself during a session.',
				noProjects: 'No project memories under the active mode yet. Open a session and its project memory directory is created automatically.',
				emptyDesc: '(no description)',
			},
		};

		/** Client plugin context captured in apply(); used for locale only. */
		let hostCtx = null;

		function normalizeLocale(locale) {
			if (typeof locale !== 'string') return 'en';
			if (locale.toLowerCase().startsWith('zh')) return 'zh';
			return 'en';
		}

		function normalizeLocaleOf(ctx) {
			try {
				const snapshot = ctx?.locale?.getLocale?.() ?? ctx?.locale?.getSnapshot?.();
				// LocaleSnapshot shape: { active, locales, revision }.
				const id = typeof snapshot === 'string' ? snapshot : snapshot?.active;
				return normalizeLocale(id);
			} catch {
				return 'en';
			}
		}

		/** Enter/Space activates a clickable table row, mirroring the click handler. */
		function rowKeydown(open) {
			return (event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					open();
				}
			};
		}

		/** Render-entry safety net: surface failures as visible text instead of a silent blank. */
		function withVisibleErrors(render) {
			return function Diagnosed(props) {
				try {
					return render(props);
				} catch (error) {
					return h(
						'div',
						{ className: 'dam-diag dam-diag-error' },
						h('strong', null, 'auto-memory render error'),
						h('pre', null, String(error && error.stack ? error.stack : error)),
					);
				}
			};
		}

		function AutoMemoryPage() {
			const [locale, setLocale] = useState('en');
			const t = useMemo(() => STRINGS[locale] ?? STRINGS.en, [locale]);
			const [status, setStatus] = useState(null);
			const [modeSelection, setModeSelection] = useState(null);
			const [allProjects, setAllProjects] = useState([]);
			const [selectedSlug, setSelectedSlug] = useState(null);
			const [listing, setListing] = useState(null);
			/** Viewer card state: { kind: 'loading', file } | { kind: 'open', file, content } | null */
			const [viewing, setViewing] = useState(null);
			const [busy, setBusy] = useState(false);
			const [message, setMessage] = useState(null);

			useEffect(() => {
				const fallback = () => {
					try {
						return typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en';
					} catch {
						return 'en';
					}
				};
				// Service properties on a Cordis context throw when not injected;
				// resolve the locale face defensively and skip on absence.
				let localeService;
				try {
					localeService = hostCtx && typeof hostCtx.locale === 'object' ? hostCtx.locale : undefined;
				} catch {
					localeService = undefined;
				}
				if (!localeService) {
					setLocale(normalizeLocale(fallback()));
					return undefined;
				}
				try {
					const read = () => {
						const snapshot =
							(typeof localeService.getLocale === 'function' ? localeService.getLocale() : undefined) ??
							(typeof localeService.getSnapshot === 'function' ? localeService.getSnapshot() : undefined);
						const id = typeof snapshot === 'string' ? snapshot : snapshot?.active;
						setLocale(normalizeLocale(id ?? fallback()));
					};
					read();
					const dispose = typeof localeService.subscribe === 'function' ? localeService.subscribe(read) : undefined;
					return typeof dispose === 'function' ? dispose : undefined;
				} catch {
					setLocale(normalizeLocale(fallback()));
					return undefined;
				}
			}, []);

			const activeMode = status?.mode ?? 'dsh';
			const projects = useMemo(
				() => allProjects.filter((project) => project.root === activeMode),
				[allProjects, activeMode],
			);

			// Latest-selection refs guard late list responses from overwriting a newly selected project.
			const selectedSlugRef = useRef(null);
			selectedSlugRef.current = selectedSlug;
			const activeModeRef = useRef(activeMode);
			activeModeRef.current = activeMode;
			const statusRef = useRef(null);

			/** Refetch the selected project's listing; a late response for a stale selection is dropped. */
			const refreshListing = useCallback(async () => {
				const slug = selectedSlugRef.current;
				const mode = activeModeRef.current;
				if (slug === null) return;
				const data = await api('list', { slug, root: mode });
				if (selectedSlugRef.current === slug && activeModeRef.current === mode) setListing(data);
			}, []);

			const pickDefaultProject = useCallback((nextStatus, nextProjects) => {
				const mode = nextStatus?.mode ?? 'dsh';
				const scoped = (nextProjects ?? []).filter((project) => project.root === mode);
				const current = nextStatus?.current;
				const pick =
					(current && scoped.find((project) => project.slug === current.slug)) || scoped[0] || null;
				setSelectedSlug(pick ? pick.slug : null);
			}, []);

			const refreshStatus = useCallback(async () => {
				const next = await api('status');
				const previous = statusRef.current;
				setStatus(next);
				statusRef.current = next;
				// Track the host's mode unless the user has a pending, unapplied selection.
				setModeSelection((selection) =>
					selection === null || (previous !== null && selection === previous.mode) ? next.mode : selection,
				);
				return next;
			}, []);

			const refreshProjects = useCallback(async () => {
				const data = await api('projects');
				setAllProjects(data.projects ?? []);
				return data.projects ?? [];
			}, []);

			useEffect(() => {
				let cancelled = false;
				(async () => {
					try {
						const nextStatus = await refreshStatus();
						const list = await refreshProjects();
						if (cancelled) return;
						pickDefaultProject(nextStatus, list);
					} catch (error) {
						if (!cancelled) setMessage({ kind: 'error', text: String(error.message ?? error) });
					}
				})();
				return () => {
					cancelled = true;
				};
			}, [refreshStatus, refreshProjects, pickDefaultProject]);

			useEffect(() => {
				if (selectedSlug === null) {
					setListing(null);
					return;
				}
				let cancelled = false;
				api('list', { slug: selectedSlug, root: activeMode })
					.then((data) => {
						if (!cancelled) setListing(data);
					})
					.catch((error) => {
						if (!cancelled) setMessage({ kind: 'error', text: String(error.message ?? error) });
					});
				return () => {
					cancelled = true;
				};
			}, [selectedSlug, activeMode]);

			const viewAbortRef = useRef(null);
			const closeView = useCallback(() => {
				viewAbortRef.current?.abort();
				viewAbortRef.current = null;
				setViewing(null);
			}, []);

			const applyMode = useCallback(async () => {
				if (modeSelection === null || modeSelection === activeMode) return;
				setBusy(true);
				setMessage(null);
				try {
					try {
						await api('setMode', { mode: modeSelection });
					} catch (error) {
						// The config edit reloads the plugin; a request landing inside that window may 404 once.
						const text = String(error.message ?? error);
						if (!/404|unknown API method/.test(text)) throw error;
						await new Promise((resolve) => setTimeout(resolve, 600));
						await api('setMode', { mode: modeSelection });
					}
					const nextStatus = await refreshStatus();
					const list = await refreshProjects();
					closeView(); // a card from the old mode's project must not linger
					pickDefaultProject(nextStatus, list);
					setMessage({ kind: 'info', text: t.modeApplied });
				} catch (error) {
					setMessage({ kind: 'error', text: String(error.message ?? error) });
				} finally {
					setBusy(false);
				}
			}, [modeSelection, activeMode, refreshStatus, refreshProjects, pickDefaultProject, closeView, t]);

			/** Row click → fetch and show the memory file in the floating viewer card. */
			const openView = useCallback(
				async (file) => {
					if (selectedSlug === null) return;
					viewAbortRef.current?.abort();
					const controller = new AbortController();
					viewAbortRef.current = controller;
					setMessage(null);
					setViewing({ kind: 'loading', file });
					try {
						const data = await api('read', { slug: selectedSlug, root: activeMode, file }, controller.signal);
						setViewing((current) => (current && current.kind === 'loading' && current.file === file ? { kind: 'open', file, content: data.content } : current));
					} catch (error) {
						if (error && error.name === 'AbortError') return; // superseded by another open or a close
						setViewing((current) => (current && current.file === file ? null : current));
						setMessage({ kind: 'error', text: String(error.message ?? error) });
					}
				},
				[selectedSlug, activeMode],
			);

			const viewerRef = useRef(null);
			// Abort an in-flight viewer fetch when the page unloads with the card open.
			useEffect(() => () => viewAbortRef.current?.abort(), []);
			// Move focus into the dialog when it opens so keyboard users are not stranded behind the overlay.
			useEffect(() => {
				if (viewing !== null) viewerRef.current?.focus();
			}, [viewing]);

			// Escape closes the viewer, matching the app's overlay conventions.
			useEffect(() => {
				if (viewing === null) return undefined;
				const onKey = (event) => {
					if (event.key === 'Escape') closeView();
				};
				window.addEventListener('keydown', onKey);
				return () => window.removeEventListener('keydown', onKey);
			}, [viewing, closeView]);

			// Error messages auto-dismiss; other messages stay until the next action.
			useEffect(() => {
				if (message === null || message.kind !== 'error') return undefined;
				const timer = setTimeout(() => setMessage(null), 6000);
				return () => clearTimeout(timer);
			}, [message]);

			const modeDirty = modeSelection !== null && modeSelection !== activeMode;

			const modeCard = (mode, title, desc) =>
				h(
					'button',
					{
						type: 'button',
						key: mode,
						className: `dam-mode-card${modeSelection === mode ? ' dam-mode-card-active' : ''}`,
						disabled: busy,
						'aria-pressed': modeSelection === mode,
						onClick: () => setModeSelection(mode),
					},
					h(
						'span',
						{ className: 'dam-mode-card-head' },
						h('span', { className: 'dam-mode-radio', 'aria-hidden': true }),
						h('strong', null, title),
						status !== null && mode === activeMode ? h('span', { className: 'dam-badge' }, t.modeCurrent) : null,
					),
					h('span', { className: 'dam-mode-card-desc' }, desc),
					h('span', { className: 'dam-mode-card-path dam-mono' }, `${status?.roots?.[mode] ?? ''}/projects/<slug>/memory`),
				);

			return h(
				'div',
				{ className: 'dam-page' },
				h(Styles, null),
				h(
					'div',
					{ className: 'dam-section dam-section-head' },
					h('h2', { className: 'dam-title' }, t.title),
					h('p', { className: 'dam-subtitle' }, t.subtitle),
				),
				h(
					'section',
					{ className: 'dam-section' },
					h('div', { className: 'dam-section-title' }, t.modeTitle),
					h('div', { className: 'dam-mode-cards' }, modeCard('dsh', t.modeDshTitle, t.modeDshDesc), modeCard('claude', t.modeClaudeTitle, t.modeClaudeDesc)),
					h(
						'div',
						{ className: 'dam-mode-actions' },
						h(
							'button',
							{
								type: 'button',
								className: 'dam-button dam-primary',
								disabled: busy || !modeDirty,
								onClick: () => void applyMode(),
							},
							t.modeApply,
						),
						h('span', { className: 'dam-hint' }, modeDirty ? t.modeHint : (activeMode === 'claude' ? t.modeSandboxHint : '')),
					),
				),
				message ? h('div', { className: `dam-message ${message.kind}` }, message.text) : null,
				h(
					'section',
					{ className: 'dam-section' },
					h(
						'div',
						{ className: 'dam-section-title dam-toolbar' },
						h('span', { className: 'dam-toolbar-label' }, t.projectTitle),
						h(
							'select',
							{
								value: selectedSlug ?? '',
								disabled: busy || projects.length === 0,
								onChange: (event) => {
									setSelectedSlug(event.target.value || null);
									closeView();
								},
							},
							projects.length === 0 ? h('option', { value: '' }, t.noProjects) : null,
							projects.map((project) =>
								h(
									'option',
									{ key: project.slug, value: project.slug },
									`${project.slug}${status?.current?.slug === project.slug ? ` · ${t.projectCurrent}` : ''}`,
								),
							),
						),
						h(
							'button',
							{
								type: 'button',
								className: 'dam-button',
								disabled: busy,
								onClick: async () => {
									setBusy(true);
									setMessage(null);
									try {
										const nextStatus = await refreshStatus();
										const list = await refreshProjects();
										pickDefaultProject(nextStatus, list);
										// pickDefaultProject may reselect the same slug (React bails out),
										// so refresh the listing explicitly — the button must always refresh.
										await refreshListing();
									} catch (error) {
										setMessage({ kind: 'error', text: String(error.message ?? error) });
									} finally {
										setBusy(false);
									}
								},
							},
							t.refresh,
						),
					),
					listing && selectedSlug
						? h(
								'div',
								{ className: 'dam-table-wrap' },
								h(
									'table',
									{ className: 'dam-table' },
									h(
										'thead',
										null,
										h(
											'tr',
											null,
											h('th', { className: 'dam-col-name' }, t.memoryColumn),
											h('th', { className: 'dam-col-desc' }, t.descriptionColumn),
										),
									),
									h(
										'tbody',
										null,
										listing.hasIndex === true ? h(
											'tr',
											{
												key: '__index__',
												className: 'dam-row',
												tabIndex: 0,
												onClick: () => void openView('MEMORY.md'),
												onKeyDown: rowKeydown(() => openView('MEMORY.md')),
											},
											h('td', { className: 'dam-mono' }, 'MEMORY.md'),
											h('td', { className: 'dam-desc', title: t.indexDesc }, t.indexDesc),
										) : null,
										listing.files.length === 0
											? h('tr', { key: '__empty__' }, h('td', { colSpan: 2, className: 'dam-empty' }, t.empty))
											: listing.files.map((file) =>
													h(
														'tr',
														{
															key: file.file,
															className: 'dam-row',
															tabIndex: 0,
															onClick: () => void openView(file.file),
															onKeyDown: rowKeydown(() => openView(file.file)),
														},
														h('td', { className: 'dam-mono' }, file.name || file.file),
														h(
															'td',
															{ className: 'dam-desc', title: file.description || '' },
															file.description || t.emptyDesc,
														),
													),
												),
									),
								),
								h('div', { className: 'dam-dir' }, `${t.projectDir}: ${listing.dir}`),
								h('div', { className: 'dam-hint dam-click-hint' }, t.clickRowHint),
						  )
						: null,
				),
				viewing
					? h(
							'div',
							{
								className: 'dam-overlay',
								onClick: (event) => {
									if (event.target === event.currentTarget) closeView();
								},
							},
							h(
								'div',
								{ className: 'dam-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dam-viewer-title', ref: viewerRef, tabIndex: -1 },
								h(
									'div',
									{ className: 'dam-viewer-head' },
									h('span', { id: 'dam-viewer-title', className: 'dam-mono dam-viewer-name' }, viewing.file),
									h(
										'button',
										{ type: 'button', className: 'dam-close', 'aria-label': t.close, onClick: closeView },
										'✕',
									),
								),
								viewing.kind === 'loading'
									? h('div', { className: 'dam-viewer-body dam-viewer-loading' }, t.loading)
									: h('pre', { className: 'dam-viewer-body' }, viewing.content),
							),
					  )
					: null,
			);
		}

		function Styles() {
			return h('style', null, `
.dam-page { display: flex; flex-direction: column; min-width: 0; max-width: 860px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.5; }
.dam-section { min-width: 0; padding: 16px 0; border-top: .5px solid var(--dsw-alias-border-l1); }
.dam-section-head { border-top: none; padding-top: 0; }
.dam-title { color: var(--dsw-alias-label-primary); font-size: 16px; font-weight: 600; margin: 0 0 2px; }
.dam-subtitle { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dam-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dam-section-title { color: var(--dsw-alias-label-tertiary); font-size: 11px; font-weight: 500; letter-spacing: .02em; margin-bottom: 8px; }
.dam-mode-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.dam-mode-card { display: flex; flex-direction: column; gap: 3px; text-align: left; background: var(--dsw-alias-settings-card-fill); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-settings-card-stroke); border-radius: var(--dsw-radius-md); padding: 8px 10px; cursor: pointer; font: inherit; }
.dam-mode-card:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dam-mode-card-active { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent) inset; }
.dam-mode-card-head { display: flex; align-items: center; gap: 7px; }
.dam-mode-card-head strong { font-size: 12.5px; font-weight: 600; }
.dam-mode-radio { width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid var(--dsw-alias-border-l2); display: inline-block; flex: none; }
.dam-mode-card-active .dam-mode-radio { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-brand-primary); }
.dam-mode-card-desc { color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.dam-mode-card-path { color: var(--dsw-alias-label-tertiary); font-size: 10.5px; word-break: break-all; }
.dam-mode-actions { display: flex; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
.dam-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dam-toolbar-label { font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-tertiary); }
.dam-button { background: transparent; color: var(--dsw-alias-label-primary); border: none; border-radius: var(--dsw-radius-sm); padding: 4px 10px; font: inherit; font-size: 12.5px; cursor: pointer; }
.dam-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dam-button:disabled { opacity: .5; cursor: default; }
.dam-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); border-radius: var(--dsw-radius-md); }
.dam-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dam-message { border-radius: var(--dsw-radius-sm); padding: 6px 10px; font-size: 12.5px; }
.dam-message.error { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-interactive-bg-hover); }
.dam-message.info { color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-interactive-bg-hover); }
.dam-table-wrap { min-width: 0; }
.dam-table { width: 100%; table-layout: fixed; border-collapse: collapse; border-block: .5px solid var(--dsw-alias-border-l2); font-size: 13px; }
.dam-table th { text-align: left; color: var(--dsw-alias-label-tertiary); font-weight: 500; font-size: 11px; padding: 6px 10px; }
.dam-col-name { width: 40%; }
.dam-col-desc { width: 60%; }
.dam-table td { padding: 7px 10px; border-top: .5px solid var(--dsw-alias-border-l1); vertical-align: top; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dam-row { cursor: pointer; }
.dam-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dam-row:hover td { background: var(--dsw-alias-interactive-bg-hover); }
.dam-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.dam-badge { display: inline-block; background: var(--dsw-alias-interactive-bg-hover); border-radius: var(--dsw-radius-sm); padding: 1px 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dam-desc { color: var(--dsw-alias-label-secondary); }
.dam-empty { color: var(--dsw-alias-label-tertiary); text-align: center; padding: 16px 0; }
.dam-dir { margin-top: 8px; font-size: 11px; color: var(--dsw-alias-label-tertiary); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; }
.dam-click-hint { margin-top: 4px; }
.dam-overlay { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; background-color: var(--dsw-alias-bg-mask-drop); backdrop-filter: blur(10px); animation: .16s ease-out dam-fade-in; }
@keyframes dam-fade-in { from { opacity: 0 } to { opacity: 1 } }
.dam-viewer { width: min(720px, calc(100vw - 48px)); max-height: min(640px, calc(100vh - 96px)); display: flex; flex-direction: column; border-radius: var(--dsw-radius-panel); background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent); overflow: hidden; }
.dam-viewer-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 6px 6px 14px; border-bottom: .5px solid var(--dsw-alias-border-l2); flex: none; }
.dam-viewer-name { font-size: 12.5px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dam-close { border: none; background: transparent; color: var(--dsw-alias-label-primary); border-radius: var(--dsw-radius-sm); width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; padding: 0; font: inherit; font-size: 14px; line-height: 1; cursor: pointer; }
.dam-close:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dam-viewer-body { margin: 0; padding: 14px 16px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-primary); }
.dam-viewer-loading { color: var(--dsw-alias-label-tertiary); font-family: inherit; font-size: 12.5px; }
.dam-diag { background: var(--dsw-alias-interactive-bg-hover); border: 1px dashed var(--dsw-alias-state-error-primary); border-radius: var(--dsw-radius-sm); padding: 6px 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.dam-diag-error { color: var(--dsw-alias-state-error-primary); }
.dam-diag pre { margin: 6px 0 0; white-space: pre-wrap; font-size: 11px; }
.dam-page select { background: var(--dsw-alias-settings-card-fill); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-settings-card-stroke); border-radius: var(--dsw-radius-sm); padding: 3px 8px; font: inherit; font-size: 12.5px; max-width: 320px; }
			`);
		}

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				hostCtx = ctx;
				const label = () => (STRINGS[normalizeLocaleOf(ctx)] ?? STRINGS.en).title;
				return ctx.slots.inject('settings.section', () =>
					ctx.slots.register(
						{
							name: 'settings.section',
							id: 'auto-memory',
							order: 60,
							label,
						},
						withVisibleErrors(AutoMemoryPage),
					),
				);
			},
		};
	},
});
