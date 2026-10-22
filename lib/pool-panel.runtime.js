		//#region src/pool-panel.tsx
		/**
		* Sidebar panel for the WorkBuddy account pool.
		*
		* Registered into the host's `sidebar.panellist` / `main` seats — the same
		* contract the plugin market uses for its own row. Read-only: it consumes
		* the existing status route and never spends credit, refreshes a token, or
		* switches accounts by itself.
		*/
		const POOL_POLL_MS = 3e4;
		async function readPoolStatus(path, signal) {
			const response = await fetch(path, {
				headers: { accept: "application/json" },
				credentials: "same-origin",
				...signal === void 0 ? {} : { signal }
			});
			const value = await response.json().catch(() => void 0);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return value;
		}
		/** Remaining token lifetime, coarse. */
		function poolFormatExpiry(ms) {
			if (typeof ms !== "number" || ms <= 0) return "unknown";
			const left = ms - Date.now();
			if (left <= 0) return "expired";
			const days = Math.floor(left / 864e5);
			if (days >= 1) return `${days}d`;
			const hours = Math.floor(left / 36e5);
			if (hours >= 1) return `${hours}h`;
			return `${Math.max(1, Math.floor(left / 6e4))}m`;
		}
		function poolFormatCooldown(seconds) {
			if (typeof seconds !== "number" || seconds <= 0) return void 0;
			if (seconds >= 3600) return `${Math.round(seconds / 3600)}h`;
			if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
			return `${Math.round(seconds)}s`;
		}
		const poolStyles = {
			root: {
				display: "flex",
				flexDirection: "column",
				gap: 14,
				padding: "14px 16px 28px",
				fontSize: 13,
				lineHeight: 1.45,
				height: "100%",
				overflowY: "auto",
				boxSizing: "border-box"
			},
			header: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
			title: { fontSize: 15, fontWeight: 600, margin: 0 },
			muted: { opacity: 0.62, fontSize: 12 },
			section: { display: "flex", flexDirection: "column", gap: 8 },
			sectionTitle: {
				fontSize: 11,
				fontWeight: 600,
				letterSpacing: "0.04em",
				textTransform: "uppercase",
				opacity: 0.55,
				margin: 0
			},
			card: {
				border: "1px solid color-mix(in srgb, currentColor 16%, transparent)",
				borderRadius: 8,
				padding: "9px 11px",
				display: "flex",
				flexDirection: "column",
				gap: 4
			},
			row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 },
			name: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			pill: {
				fontSize: 10,
				fontWeight: 600,
				padding: "1px 7px",
				borderRadius: 999,
				border: "1px solid currentColor",
				whiteSpace: "nowrap"
			},
			okPill: { color: "#1a7f37", borderColor: "color-mix(in srgb, #1a7f37 45%, transparent)" },
			coolPill: { color: "#9a6700", borderColor: "color-mix(in srgb, #9a6700 45%, transparent)" },
			deadPill: { color: "#b42318", borderColor: "color-mix(in srgb, #b42318 45%, transparent)" },
			models: { display: "flex", flexWrap: "wrap", gap: 5 },
			model: {
				fontSize: 11,
				padding: "1px 6px",
				borderRadius: 5,
				border: "1px solid color-mix(in srgb, currentColor 14%, transparent)",
				display: "inline-flex",
				gap: 5,
				alignItems: "baseline"
			},
			btn: {
				fontSize: 11,
				padding: "2px 9px",
				borderRadius: 6,
				border: "1px solid color-mix(in srgb, currentColor 25%, transparent)",
				background: "transparent",
				color: "inherit",
				cursor: "pointer"
			},
			notice: {
				fontSize: 12,
				padding: "7px 10px",
				borderRadius: 7,
				border: "1px solid color-mix(in srgb, #b42318 35%, transparent)",
				color: "#b42318"
			}
		};

		/** Human label for an upstream failure class recorded on an account. */
		function poolFailureLabel(kind) {
			switch (kind) {
				case "hard_credit":
					return "额度耗尽";
				case "soft_rate":
					return "请求限流";
				case "session_dead":
					return "登录失效";
				case "not_found":
					return "模型不可用";
				case "server":
					return "上游错误";
				default:
					return String(kind);
			}
		}
		/** Human label for the catalog provenance reported by the host. */
		function poolSourceLabel(source) {
			switch (source) {
				case "live":
				case "workbuddy-ai:app":
				case "workbuddy:cli":
					return "实时";
				case "saved":
					return "已保存";
				case "fallback":
					return "内置";
				default:
					return String(source);
			}
		}
		function PoolPill({ kind, children }) {
			const tone = kind === "ok" ? poolStyles.okPill : kind === "cool" ? poolStyles.coolPill : poolStyles.deadPill;
			return react.createElement("span", {
				style: { ...poolStyles.pill, ...tone }
			}, children);
		}
		/** The account's own credit balance, or undefined when it is not known. */
		function poolAccountCredit(account) {
			const credits = account?.credits;
			if (credits === void 0) return void 0;
			if (typeof credits.error === "string") return `查询失败`;
			return typeof credits.total === "number" ? String(credits.total) : void 0;
		}
		function PoolAccountCard({ account, isActive, available }) {
			const cooldown = poolFormatCooldown(account.coolingDownSeconds);
			const kind = cooldown !== void 0 ? "cool" : available ? "ok" : "dead";
			const label = cooldown !== void 0 ? `冷却 ${cooldown}` : available ? "就绪" : "不可用";
			return react.createElement("div", { style: poolStyles.card },
				react.createElement("div", { style: poolStyles.row },
					react.createElement("span", { style: poolStyles.name }, account.label ?? String(account.uid).slice(0, 8)),
					react.createElement("span", { style: { display: "flex", gap: 6, alignItems: "center" } },
						isActive ? react.createElement(PoolPill, { kind: "ok" }, "使用中") : null,
						react.createElement(PoolPill, { kind }, label)
					)
				),
				react.createElement("div", { style: { ...poolStyles.row, ...poolStyles.muted } },
					react.createElement("span", null, `${account.file} · ${String(account.uid).slice(0, 8)}`),
					react.createElement("span", null, `令牌 ${poolFormatExpiry(account.expiresAtMs)}`)
				),
				poolAccountCredit(account) === void 0 ? null : react.createElement("div", { style: poolStyles.row },
					react.createElement("span", null, "账号积分"),
					react.createElement("span", { style: { fontWeight: 600 } }, poolAccountCredit(account))
				),
				account.lastError ? react.createElement("div", { style: poolStyles.muted }, `最近失败：${poolFailureLabel(account.lastError)}`) : null
			);
		}
		function PoolModelList({ models }) {
			if (!Array.isArray(models) || models.length === 0) return react.createElement("div", { style: poolStyles.muted }, "当前模型列表为空");
			return react.createElement("div", { style: poolStyles.models }, models.map((model) => react.createElement("span", {
				key: model.id,
				style: poolStyles.model,
				title: model.id
			},
				react.createElement("span", null, model.name ?? model.id),
				model.credits ? react.createElement("span", { style: poolStyles.muted }, `x${model.credits}`) : null,
				model.free ? react.createElement("span", { style: { color: "#1a7f37" } }, "免费") : null,
				Array.isArray(model.badges) && model.badges.length > 0 ? react.createElement("span", { style: { color: "#9a6700" } }, model.badges.join(" · ")) : null
			)));
		}
		function WorkBuddyPoolPanel(props) {
			const variant = props?.variant ?? AI_CARD_VARIANT;
			const [status, setStatus] = react.useState(void 0);
			const [failure, setFailure] = react.useState(void 0);
			const [busy, setBusy] = react.useState(false);
			const mounted = react.useRef(true);
			const seq = react.useRef(0);
			const refresh = react.useCallback(async (signal) => {
				const at = ++seq.current;
				try {
					const value = await readPoolStatus(variant.statusPath, signal);
					if (!mounted.current || at !== seq.current) return;
					setStatus(value);
					setFailure(void 0);
				} catch (error) {
					if (!mounted.current || at !== seq.current) return;
					setFailure(error instanceof Error ? error.message : String(error));
				}
			}, [variant.statusPath]);
			react.useEffect(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			react.useEffect(() => {
				const controller = new AbortController();
				refresh(controller.signal);
				const timer = window.setInterval(() => refresh(new AbortController().signal), POOL_POLL_MS);
				return () => {
					window.clearInterval(timer);
					controller.abort();
				};
			}, [refresh]);
			const manual = async () => {
				setBusy(true);
				try {
					await refresh(void 0);
				} finally {
					if (mounted.current) setBusy(false);
				}
			};
			const pool = status?.pool;
			const accounts = Array.isArray(pool?.accounts) ? pool.accounts : [];
			const signedIn = status?.status === "signed-in";
			const credits = status?.credits;
			const creditText = typeof credits?.total === "number" ? `${variant.creditPrefix}${credits.total}` : void 0;
			return react.createElement("div", { style: poolStyles.root },
				react.createElement("div", { style: poolStyles.header },
					react.createElement("h3", { style: poolStyles.title }, "WorkBuddy Multi"),
					react.createElement("button", {
						type: "button",
						style: poolStyles.btn,
						onClick: manual,
						disabled: busy
					}, busy ? "..." : "刷新")
				),
				failure === void 0 ? null : react.createElement("div", { style: poolStyles.notice }, `状态读取失败：${failure}`),
				react.createElement("div", { style: poolStyles.card },
					react.createElement("div", { style: poolStyles.row },
						react.createElement("span", { style: poolStyles.name }, signedIn ? status.nickname ?? "已登录" : "未登录"),
						signedIn ? react.createElement(PoolPill, { kind: "ok" }, "当前使用") : react.createElement(PoolPill, { kind: "dead" }, "未登录")
					),
					react.createElement("div", { style: { ...poolStyles.row, ...poolStyles.muted } },
						react.createElement("span", null, signedIn ? status.domain ?? "未知域名" : status?.reason ?? "请先在 WorkBuddy AI 应用中登录一次"),
						react.createElement("span", null, signedIn ? `令牌 ${poolFormatExpiry(status.expiresAt)}` : "")
					),
					creditText === void 0 ? null : react.createElement("div", { style: poolStyles.row },
						react.createElement("span", null, "剩余积分"),
						react.createElement("span", { style: { fontWeight: 600 } }, creditText)
					),
					credits?.error ? react.createElement("div", { style: poolStyles.muted }, `积分查询失败：${credits.error}`) : null
				),
				react.createElement("div", { style: poolStyles.section },
					react.createElement("h4", { style: poolStyles.sectionTitle }, `账号池${pool === void 0 ? "" : ` · ${accounts.length}`}`),
					pool === void 0 ? react.createElement("div", { style: poolStyles.muted }, "单账号模式（未配置账号池目录）")
						: accounts.length === 0 ? react.createElement("div", { style: poolStyles.muted }, "账号池目录为空")
						: accounts.map((account) => react.createElement(PoolAccountCard, {
							key: account.file,
							account,
							isActive: account.file === pool.activeFile,
							available: account.coolingDownSeconds === 0
						}))
				),
				react.createElement("div", { style: poolStyles.section },
					react.createElement("h4", { style: poolStyles.sectionTitle },
						`模型${Array.isArray(status?.models) ? ` · ${status.models.length}` : ""}`,
						status?.catalog?.source ? react.createElement("span", { style: poolStyles.muted }, ` · 来源 ${poolSourceLabel(status.catalog.source)}`) : null
					),
					react.createElement(PoolModelList, { models: status?.models })
				)
			);
		}
		//#endregion
