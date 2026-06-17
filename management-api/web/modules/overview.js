window.AppModules = window.AppModules || {};

window.AppModules.overview = {
  state() {
    return {
      overviewLoading: false,
      overviewError: '',
      overviewTimer: null,
      overviewQueue: [],
      overviewUpdatedAt: null,
      agentStats: [],
      agentStatsWindow: '7d',
      agentStatsLoading: false,
      budgets: null,
      budgetsLoading: false,
      budgetEditorOpen: false,
      budgetDraft: {
        enabled: true,
        daily: { maxCostUsd: '', maxRuns: '', maxTokens: '' },
        agents: {},
        workflows: {},
        toolsets: {},
        triggers: {},
      },
      budgetSaving: false,
      budgetError: '',
      budgetNewScope: { kind: 'agents', name: '' },
      notifications: null,
      notificationsLoading: false,
      notificationEditorOpen: false,
      notificationDraft: {
        enabled: true,
        default: {
          mode: 'immediate',
          notifyOnFailure: true,
          minSeverity: 'info',
          channel: { platform: '', id: '' },
          quietHours: { enabled: false, start: '22:00', end: '07:00', timezone: 'America/Chicago', allowFailures: true },
        },
        agents: {},
        workflows: {},
        toolsets: {},
        triggers: {},
      },
      notificationSaving: false,
      notificationError: '',
      notificationNewScope: { kind: 'agents', name: '' },
    };
  },

  methods: {
    startOverviewRefresh() {
      this.loadOverview();
      this.stopOverviewRefresh();
      this.overviewTimer = setInterval(() => this.loadOverview(), 15000);
    },

    stopOverviewRefresh() {
      if (this.overviewTimer) {
        clearInterval(this.overviewTimer);
        this.overviewTimer = null;
      }
    },

    async loadOverview() {
      this.overviewLoading = true;
      this.overviewError = '';
      try {
        await Promise.all([
          this.loadAgents(),
          this.loadJobs(),
          this.loadHealth(),
          this.loadInbox(),
          this.loadActivity(),
          this.loadOverviewQueue(),
          this.loadBudgets(),
          this.loadNotifications(),
        ]);
        this.overviewUpdatedAt = new Date().toISOString();
      } catch (err) {
        this.overviewError = err.message;
      } finally {
        this.overviewLoading = false;
      }
    },

    async loadOverviewQueue() {
      try {
        const r = await fetch('api/queue?limit=80');
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Queue load failed');
        this.overviewQueue = data.jobs || [];
        this.queue = data.jobs || [];
        this.markApiOk();
      } catch (err) {
        this.overviewQueue = [];
        this.reportApiError('Overview queue load failed', err);
      }
    },

    async loadBudgets() {
      this.budgetsLoading = true;
      try {
        const r = await fetch('api/budgets');
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Budget load failed');
        this.budgets = data;
        this.markApiOk();
      } catch (err) {
        this.budgets = null;
        this.reportApiError('Budget load failed', err);
      } finally {
        this.budgetsLoading = false;
      }
    },

    openBudgetEditor() {
      this.budgetDraft = this.normalizeBudgetPolicy(this.budgets?.policy || {});
      this.budgetNewScope = { kind: 'agents', name: '' };
      this.budgetError = '';
      this.budgetEditorOpen = true;
    },

    closeBudgetEditor() {
      this.budgetEditorOpen = false;
      this.budgetError = '';
    },

    normalizeBudgetPolicy(policy) {
      const limit = (value = {}) => ({
        maxCostUsd: value.maxCostUsd ?? '',
        maxRuns: value.maxRuns ?? '',
        maxTokens: value.maxTokens ?? '',
      });
      const limitMap = (items = {}) => Object.fromEntries(
        Object.entries(items).map(([name, item]) => [name, limit(item)])
      );
      return {
        enabled: policy.enabled !== false,
        daily: limit(policy.daily),
        agents: limitMap(policy.agents),
        workflows: limitMap(policy.workflows),
        toolsets: limitMap(policy.toolsets),
        triggers: limitMap(policy.triggers),
      };
    },

    cleanBudgetPolicy(policy) {
      const cleanLimit = (limit = {}) => {
        const cleaned = {};
        const addNumber = (key, integer = false) => {
          const raw = limit[key];
          if (raw === '' || raw === null || raw === undefined) return;
          const value = Number(raw);
          if (Number.isFinite(value) && value >= 0) cleaned[key] = integer ? Math.floor(value) : value;
        };
        addNumber('maxCostUsd');
        addNumber('maxRuns', true);
        addNumber('maxTokens', true);
        return cleaned;
      };
      const cleanMap = (items = {}) => {
        const cleaned = {};
        for (const [name, limit] of Object.entries(items)) {
          const key = String(name).trim();
          if (!key) continue;
          cleaned[key] = cleanLimit(limit);
        }
        return cleaned;
      };
      return {
        enabled: policy.enabled !== false,
        daily: cleanLimit(policy.daily),
        agents: cleanMap(policy.agents),
        workflows: cleanMap(policy.workflows),
        toolsets: cleanMap(policy.toolsets),
        triggers: cleanMap(policy.triggers),
      };
    },

    async saveBudgetPolicy() {
      if (!this.budgetDraft) return;
      this.budgetSaving = true;
      this.budgetError = '';
      try {
        const r = await fetch('api/budgets', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ policy: this.cleanBudgetPolicy(this.budgetDraft) }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Budget save failed');
        this.budgets = data;
        this.budgetEditorOpen = false;
        this.markApiOk();
      } catch (err) {
        this.budgetError = err.message;
        this.reportApiError('Budget save failed', err);
      } finally {
        this.budgetSaving = false;
      }
    },

    budgetDraftScopeRows(kind) {
      return Object.entries(this.budgetDraft?.[kind] || {}).map(([name, limit]) => ({ name, limit }));
    },

    addBudgetScope() {
      const kind = this.budgetNewScope.kind || 'agents';
      const name = String(this.budgetNewScope.name || '').trim();
      if (!name || !this.budgetDraft?.[kind]) return;
      this.budgetDraft[kind] = {
        ...this.budgetDraft[kind],
        [name]: this.budgetDraft[kind][name] || { maxCostUsd: '', maxRuns: '', maxTokens: '' },
      };
      this.budgetNewScope.name = '';
    },

    removeBudgetScope(kind, name) {
      if (!this.budgetDraft?.[kind]) return;
      const next = { ...this.budgetDraft[kind] };
      delete next[name];
      this.budgetDraft[kind] = next;
    },

    async loadNotifications() {
      this.notificationsLoading = true;
      try {
        const r = await fetch('api/notifications');
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Notification preferences load failed');
        this.notifications = data;
        this.markApiOk();
      } catch (err) {
        this.notifications = null;
        this.reportApiError('Notification preferences load failed', err);
      } finally {
        this.notificationsLoading = false;
      }
    },

    openNotificationEditor() {
      this.notificationDraft = this.normalizeNotificationPolicy(this.notifications?.policy || {});
      this.notificationNewScope = { kind: 'agents', name: '' };
      this.notificationError = '';
      this.notificationEditorOpen = true;
    },

    closeNotificationEditor() {
      this.notificationEditorOpen = false;
      this.notificationError = '';
    },

    defaultNotificationPreference() {
      return {
        mode: 'immediate',
        notifyOnFailure: true,
        minSeverity: 'info',
        channel: { platform: '', id: '' },
        quietHours: {
          enabled: false,
          start: '22:00',
          end: '07:00',
          timezone: 'America/Chicago',
          allowFailures: true,
        },
      };
    },

    normalizeNotificationPreference(pref = {}) {
      const base = this.defaultNotificationPreference();
      return {
        mode: pref.mode || base.mode,
        notifyOnFailure: pref.notifyOnFailure !== false,
        minSeverity: pref.minSeverity || base.minSeverity,
        channel: {
          platform: pref.channel?.platform || '',
          id: pref.channel?.id || '',
        },
        quietHours: {
          enabled: pref.quietHours?.enabled === true,
          start: pref.quietHours?.start || base.quietHours.start,
          end: pref.quietHours?.end || base.quietHours.end,
          timezone: pref.quietHours?.timezone || base.quietHours.timezone,
          allowFailures: pref.quietHours?.allowFailures !== false,
        },
      };
    },

    normalizeNotificationPolicy(policy) {
      const prefMap = (items = {}) => Object.fromEntries(
        Object.entries(items).map(([name, pref]) => [name, this.normalizeNotificationPreference(pref)])
      );
      return {
        enabled: policy.enabled !== false,
        default: this.normalizeNotificationPreference(policy.default),
        agents: prefMap(policy.agents),
        workflows: prefMap(policy.workflows),
        toolsets: prefMap(policy.toolsets),
        triggers: prefMap(policy.triggers),
      };
    },

    cleanNotificationPreference(pref = {}) {
      const cleaned = {
        mode: pref.mode || 'immediate',
        notifyOnFailure: pref.notifyOnFailure !== false,
        minSeverity: pref.minSeverity || 'info',
      };
      const platform = String(pref.channel?.platform || '').trim();
      const id = String(pref.channel?.id || '').trim();
      if (platform && id) cleaned.channel = { platform, id };
      if (pref.quietHours?.enabled) {
        cleaned.quietHours = {
          enabled: true,
          start: pref.quietHours?.start || '22:00',
          end: pref.quietHours?.end || '07:00',
          timezone: pref.quietHours?.timezone || 'America/Chicago',
          allowFailures: pref.quietHours?.allowFailures !== false,
        };
      }
      return cleaned;
    },

    cleanNotificationPolicy(policy) {
      const cleanMap = (items = {}) => {
        const cleaned = {};
        for (const [name, pref] of Object.entries(items)) {
          const key = String(name).trim();
          if (!key) continue;
          cleaned[key] = this.cleanNotificationPreference(pref);
        }
        return cleaned;
      };
      return {
        enabled: policy.enabled !== false,
        default: this.cleanNotificationPreference(policy.default),
        agents: cleanMap(policy.agents),
        workflows: cleanMap(policy.workflows),
        toolsets: cleanMap(policy.toolsets),
        triggers: cleanMap(policy.triggers),
      };
    },

    async saveNotificationPolicy() {
      this.notificationSaving = true;
      this.notificationError = '';
      try {
        const r = await fetch('api/notifications', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ policy: this.cleanNotificationPolicy(this.notificationDraft) }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Notification save failed');
        this.notifications = data;
        this.notificationEditorOpen = false;
        this.markApiOk();
      } catch (err) {
        this.notificationError = err.message;
        this.reportApiError('Notification save failed', err);
      } finally {
        this.notificationSaving = false;
      }
    },

    notificationDraftScopeRows(kind) {
      return Object.entries(this.notificationDraft?.[kind] || {}).map(([name, pref]) => ({ name, pref }));
    },

    addNotificationScope() {
      const kind = this.notificationNewScope.kind || 'agents';
      const name = String(this.notificationNewScope.name || '').trim();
      if (!name || !this.notificationDraft?.[kind]) return;
      this.notificationDraft[kind] = {
        ...this.notificationDraft[kind],
        [name]: this.notificationDraft[kind][name] || this.defaultNotificationPreference(),
      };
      this.notificationNewScope.name = '';
    },

    removeNotificationScope(kind, name) {
      if (!this.notificationDraft?.[kind]) return;
      const next = { ...this.notificationDraft[kind] };
      delete next[name];
      this.notificationDraft[kind] = next;
    },

    notificationRows() {
      const policy = this.notifications?.policy;
      if (!policy) return [];
      const rows = [];
      const add = (scope, pref) => {
        if (!pref) return;
        rows.push({
          scope,
          mode: pref.mode || 'immediate',
          notifyOnFailure: pref.notifyOnFailure !== false,
          minSeverity: pref.minSeverity || 'info',
          quietHours: pref.quietHours,
          channel: pref.channel ? `${pref.channel.platform}:${pref.channel.id}` : 'job channel',
        });
      };
      add('default', policy.default);
      for (const [name, pref] of Object.entries(policy.agents || {})) add(`agent: ${name}`, pref);
      for (const [name, pref] of Object.entries(policy.workflows || {})) add(`workflow: ${name}`, pref);
      for (const [name, pref] of Object.entries(policy.toolsets || {})) add(`toolset: ${name}`, pref);
      for (const [name, pref] of Object.entries(policy.triggers || {})) add(`trigger: ${name}`, pref);
      return rows;
    },

    notificationModeClass(mode) {
      return {
        immediate: 'text-green-400 border-green-900 bg-green-950/20',
        failures_only: 'text-yellow-400 border-yellow-900 bg-yellow-950/20',
        digest: 'text-indigo-300 border-indigo-900 bg-indigo-950/20',
        silent: 'text-gray-500 border-gray-800 bg-gray-900',
      }[mode] || 'text-gray-400 border-gray-800 bg-gray-900';
    },

    notificationSeverityClass(severity) {
      return {
        info: 'text-gray-300 border-gray-800 bg-gray-900',
        warn: 'text-yellow-400 border-yellow-900 bg-yellow-950/20',
        error: 'text-red-300 border-red-900 bg-red-950/20',
        critical: 'text-red-200 border-red-800 bg-red-950/40',
      }[severity] || 'text-gray-400 border-gray-800 bg-gray-900';
    },

    notificationQuietText(row) {
      const quiet = row.quietHours;
      if (!quiet?.enabled) return 'off';
      const failures = quiet.allowFailures === false ? 'blocks failures' : 'failures pass';
      return `${quiet.start || '22:00'}-${quiet.end || '07:00'} · ${failures}`;
    },

    budgetRows() {
      if (!this.budgets?.policy || !this.budgets?.usage) return [];
      const rows = [];
      const add = (scope, limit, usage) => {
        if (!limit || !usage) return;
        const costPct = typeof limit.maxCostUsd === 'number' && limit.maxCostUsd > 0
          ? Math.round((usage.costUsd / limit.maxCostUsd) * 100)
          : null;
        const runPct = typeof limit.maxRuns === 'number' && limit.maxRuns > 0
          ? Math.round((usage.runs / limit.maxRuns) * 100)
          : null;
        const tokenPct = typeof limit.maxTokens === 'number' && limit.maxTokens > 0
          ? Math.round(((usage.tokens || 0) / limit.maxTokens) * 100)
          : null;
        rows.push({
          scope,
          limit,
          usage,
          costPct,
          runPct,
          tokenPct,
          pct: Math.max(costPct || 0, runPct || 0, tokenPct || 0),
        });
      };
      add('daily', this.budgets.policy.daily, this.budgets.usage.daily);
      for (const [name, limit] of Object.entries(this.budgets.policy.agents || {})) {
        add(`agent: ${name}`, limit, this.budgets.usage.agents?.[name]);
      }
      for (const [name, limit] of Object.entries(this.budgets.policy.workflows || {})) {
        add(`workflow: ${name}`, limit, this.budgets.usage.workflows?.[name]);
      }
      for (const [name, limit] of Object.entries(this.budgets.policy.toolsets || {})) {
        add(`toolset: ${name}`, limit, this.budgets.usage.toolsets?.[name]);
      }
      for (const [name, limit] of Object.entries(this.budgets.policy.triggers || {})) {
        add(`trigger: ${name}`, limit, this.budgets.usage.triggers?.[name]);
      }
      return rows.sort((a, b) => b.pct - a.pct || a.scope.localeCompare(b.scope));
    },

    budgetTone(row) {
      if (row.pct >= 100) return 'text-red-400';
      if (row.pct >= 80) return 'text-yellow-400';
      return 'text-gray-400';
    },

    budgetTrendRows() {
      return (this.budgets?.trends || [])
        .filter(row => row.severity === 'warn' || (row.current?.costUsd || 0) > 0 || (row.current?.tokens || 0) > 0)
        .slice(0, 8);
    },

    budgetTrendTone(row) {
      if (row.severity === 'warn') return 'text-yellow-400 border-yellow-900 bg-yellow-950/20';
      return 'text-gray-400 border-gray-800 bg-gray-900';
    },

    formatPercentChange(value) {
      if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
      const rounded = Math.round(Number(value));
      return `${rounded > 0 ? '+' : ''}${rounded}%`;
    },

    overviewMetricCards() {
      const activeAgents = this.agents.filter(agent => agent.status === 'Active').length;
      const running = this.overviewQueue.filter(job => job.status === 'running').length;
      const pending = this.overviewQueue.filter(job => job.status === 'pending').length;
      const failed = this.overviewQueue.filter(job => job.status === 'failed').length;
      const enabledJobs = this.jobs.filter(job => job.enabled).length;
      const cost = this.overviewQueue.reduce((sum, job) => sum + (job.result?.totalCostUsd || 0), 0);
      const healthChecks = this.overviewHealthChecks();
      const healthOk = healthChecks.filter(Boolean).length;
      const healthTotal = healthChecks.length;
      const incidentCount = (this.health?.incidents || []).length;
      const criticalIncidents = this.health?.incidentSummary?.critical || 0;

      return [
        { label: 'Agents', value: activeAgents, detail: `${this.agents.length} total`, tone: activeAgents ? 'green' : 'gray', section: 'agents' },
        { label: 'Queue', value: running + pending, detail: `${running} running · ${pending} pending`, tone: running ? 'indigo' : pending ? 'yellow' : 'gray', section: 'jobs' },
        { label: 'Failures', value: failed, detail: 'recent queue', tone: failed ? 'red' : 'green', section: 'jobs' },
        { label: 'Inbox', value: this.inboxFiles.length, detail: 'files waiting', tone: this.inboxFiles.length ? 'yellow' : 'gray', section: 'inbox' },
        { label: 'Schedules', value: enabledJobs, detail: `${this.jobs.length} total`, tone: enabledJobs ? 'indigo' : 'gray', section: 'jobs' },
        { label: 'Cost', value: this.formatUsd(cost), detail: 'recent queue', tone: cost > 1 ? 'yellow' : 'gray', section: 'jobs' },
        { label: 'Health', value: criticalIncidents ? criticalIncidents : (healthTotal ? `${healthOk}/${healthTotal}` : '-'), detail: incidentCount ? `${incidentCount} incident${incidentCount === 1 ? '' : 's'}` : 'checks passing', tone: criticalIncidents ? 'red' : incidentCount ? 'yellow' : (healthTotal ? (healthOk === healthTotal ? 'green' : 'red') : 'gray'), section: 'health' },
      ];
    },

    overviewCardClass(tone) {
      return {
        green: 'border-green-900 bg-green-950/20',
        red: 'border-red-900 bg-red-950/20',
        yellow: 'border-yellow-900 bg-yellow-950/20',
        indigo: 'border-indigo-900 bg-indigo-950/20',
        gray: 'border-gray-800 bg-gray-900',
      }[tone] || 'border-gray-800 bg-gray-900';
    },

    overviewHealthChecks() {
      if (!this.health) return [];
      return [
        Boolean(this.health.runtime?.ok),
        ...Object.values(this.health.paths || {}).map(item => Boolean(item.exists)),
        ...(this.health.logs || []).map(item => Boolean(item.exists)),
        ...((this.health.incidents || []).map(item => item.severity !== 'critical')),
      ];
    },

    overviewRecentFailures() {
      const queueFailures = this.overviewQueue
        .filter(job => job.status === 'failed')
        .map(job => ({
          id: `job:${job.id}`,
          type: 'job',
          title: this.jobTitle(job),
          detail: job.result?.error || job.trigger || job.id,
          time: job.completedAt || job.updatedAt || job.startedAt || job.createdAt,
          job,
        }));
      const cardFailures = this.activity
        .filter(entry => entry.ok === false)
        .map(entry => ({
          id: `card:${entry.filename}`,
          type: 'card',
          title: `${entry.agent || 'Agent'} / ${entry.action || 'Run'}`,
          detail: entry.summary || entry.filename,
          time: entry.mtime,
          entry,
        }));
      return queueFailures
        .concat(cardFailures)
        .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
        .slice(0, 6);
    },

    overviewRecentWork() {
      const jobs = this.overviewQueue.map(job => ({
        id: `job:${job.id}`,
        type: 'job',
        title: this.jobTitle(job),
        status: job.status,
        detail: job.trigger || job.id,
        time: job.startedAt || job.createdAt,
        job,
      }));
      const cards = this.activity.map(entry => ({
        id: `card:${entry.filename}`,
        type: 'card',
        title: `${entry.agent || 'Agent'} / ${entry.action || 'Run'}`,
        status: entry.ok ? 'done' : 'failed',
        detail: entry.summary || entry.filename,
        time: entry.mtime,
        entry,
      }));
      return jobs
        .concat(cards)
        .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
        .slice(0, 10);
    },

    overviewAgentLeaders() {
      const counts = new Map();
      const touch = (name, status) => {
        if (!name) return;
        const key = name.toLowerCase();
        const item = counts.get(key) || { name, runs: 0, failures: 0 };
        item.runs += 1;
        if (status === 'failed') item.failures += 1;
        counts.set(key, item);
      };
      for (const job of this.overviewQueue) touch(job.agent, job.status);
      for (const entry of this.activity) touch(entry.agent, entry.ok ? 'done' : 'failed');
      return Array.from(counts.values())
        .sort((a, b) => b.runs - a.runs || b.failures - a.failures || a.name.localeCompare(b.name))
        .slice(0, 8);
    },

    overviewOpenAgent(name) {
      const agent = this.agents.find(item => item.name.toLowerCase() === String(name).toLowerCase());
      this.navigate('agents');
      if (agent) this.$nextTick(() => this.selectAgent(agent));
    },

    overviewItemStatusClass(status) {
      return this.queueStatusColor(status || 'done');
    },

    overviewWasteSignals() {
      const signals = [];
      for (const job of this.overviewQueue) {
        for (const hint of job.result?.efficiencyHints || []) {
          signals.push({
            id: `${job.id}:${hint.type}:${signals.length}`,
            job,
            title: this.jobTitle(job),
            hint,
            cost: job.result?.totalCostUsd || 0,
            durationMs: job.result?.durationMs || 0,
          });
        }
        for (const step of job.result?.stepResults || []) {
          for (const hint of step.efficiencyHints || []) {
            signals.push({
              id: `${job.id}:step:${step.step}:${hint.type}:${signals.length}`,
              job,
              title: `${this.jobTitle(job)} / step ${step.step}`,
              hint,
              cost: step.totalCostUsd || 0,
              durationMs: step.durationMs || 0,
            });
          }
        }
      }
      return signals
        .sort((a, b) => (b.hint.severity === 'warn') - (a.hint.severity === 'warn') || b.cost - a.cost || b.durationMs - a.durationMs)
        .slice(0, 8);
    },

    efficiencyRows() {
      return this.overviewQueue
        .filter(job => job.result)
        .map(job => ({
          job,
          title: this.jobTitle(job),
          cost: job.result?.totalCostUsd || 0,
          durationMs: job.result?.durationMs || 0,
          tokens: job.result?.totalTokens || 0,
          toolCalls: job.result?.toolCallCount || 0,
          hints: job.result?.efficiencyHints || [],
        }))
        .sort((a, b) => b.cost - a.cost || b.durationMs - a.durationMs || b.toolCalls - a.toolCalls);
    },

    async loadAgentStats(window) {
      if (window) this.agentStatsWindow = window;
      this.agentStatsLoading = true;
      try {
        const r = await fetch(`api/queue/stats?window=${encodeURIComponent(this.agentStatsWindow)}`);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Stats load failed');
        this.agentStats = data.stats || [];
      } catch (err) {
        this.agentStats = [];
        this.reportApiError('Agent stats load failed', err);
      } finally {
        this.agentStatsLoading = false;
      }
    },

    agentStatsRows() {
      return this.agentStats.map(row => ({
        ...row,
        successRate: row.jobCount > 0 ? Math.round((row.doneCount / row.jobCount) * 100) : null,
        avgCostUsd: row.doneCount > 0 ? row.totalCostUsd / row.doneCount : 0,
        avgOutputChars: row.doneCount > 0 ? Math.round((row.totalOutputChars || 0) / row.doneCount) : 0,
        coachingScore: this.agentCoachingScore(row),
        coachingReasons: this.agentCoachingReasons(row),
      }));
    },

    agentCoachingScore(row) {
      const failureRate = row.jobCount > 0 ? row.failedCount / row.jobCount : 0;
      return Math.round(
        (failureRate * 45) +
        ((row.totalCostUsd || 0) * 8) +
        ((row.lowOutputCount || 0) * 12) +
        ((row.oversizedToolsetCount || 0) * 8) +
        ((row.lowValueStepCount || 0) * 6) +
        ((row.repeatedStepCount || 0) * 10) +
        ((row.warnHintCount || 0) * 4)
      );
    },

    agentCoachingReasons(row) {
      const reasons = [];
      const successRate = row.jobCount > 0 ? Math.round((row.doneCount / row.jobCount) * 100) : null;
      if ((row.failedCount || 0) > 0) reasons.push(`${row.failedCount} failed`);
      if ((row.totalCostUsd || 0) >= 0.25) reasons.push(`${this.formatUsd(row.totalCostUsd)} spent`);
      if ((row.lowOutputCount || 0) > 0) reasons.push(`${row.lowOutputCount} low-output`);
      if ((row.oversizedToolsetCount || 0) > 0) reasons.push(`${row.oversizedToolsetCount} oversized toolset`);
      if ((row.lowValueStepCount || 0) > 0) reasons.push(`${row.lowValueStepCount} low-value steps`);
      if ((row.repeatedStepCount || 0) > 0) reasons.push(`${row.repeatedStepCount} repeated steps`);
      if (successRate !== null && successRate < 70 && row.jobCount >= 2) reasons.push(`${successRate}% success`);
      return reasons.slice(0, 3);
    },

    agentQualitySummaryCards() {
      const rows = this.agentStatsRows();
      const coaching = rows.filter(row => row.coachingScore > 0);
      const failed = rows.reduce((sum, row) => sum + (row.failedCount || 0), 0);
      const lowOutput = rows.reduce((sum, row) => sum + (row.lowOutputCount || 0), 0);
      const oversized = rows.reduce((sum, row) => sum + (row.oversizedToolsetCount || 0), 0);
      const lowValueSteps = rows.reduce((sum, row) => sum + (row.lowValueStepCount || 0) + (row.repeatedStepCount || 0), 0);
      return [
        { label: 'Need Coaching', value: coaching.length, detail: `${rows.length} tracked`, tone: coaching.length ? 'yellow' : 'green' },
        { label: 'Failed Runs', value: failed, detail: this.agentStatsWindowLabel(this.agentStatsWindow), tone: failed ? 'red' : 'green' },
        { label: 'Low Output', value: lowOutput, detail: 'tiny/no artifacts', tone: lowOutput ? 'yellow' : 'gray' },
        { label: 'Toolset Fit', value: oversized, detail: 'possible oversizing', tone: oversized ? 'yellow' : 'gray' },
        { label: 'Workflow Waste', value: lowValueSteps, detail: 'merge or skip candidates', tone: lowValueSteps ? 'yellow' : 'gray' },
      ];
    },

    agentQualityRankings() {
      const rows = this.agentStatsRows();
      const rank = (filter, sorter) => rows.filter(filter).sort(sorter).slice(0, 5);
      return [
        {
          key: 'coaching',
          title: 'Needs Coaching',
          metric: row => `${row.coachingScore}`,
          detail: row => row.coachingReasons.join(' · ') || 'Watch this run pattern',
          rows: rank(row => row.coachingScore > 0, (a, b) => b.coachingScore - a.coachingScore || b.failedCount - a.failedCount),
        },
        {
          key: 'failed',
          title: 'Most Failed',
          metric: row => `${row.failedCount}`,
          detail: row => `${row.successRate ?? '-'}% success across ${this.formatNumber(row.jobCount)} jobs`,
          rows: rank(row => (row.failedCount || 0) > 0, (a, b) => b.failedCount - a.failedCount || (a.successRate ?? 100) - (b.successRate ?? 100)),
        },
        {
          key: 'expensive',
          title: 'Most Expensive',
          metric: row => this.formatUsd(row.totalCostUsd || 0),
          detail: row => `${this.formatUsd(row.avgCostUsd || 0)} avg · ${this.formatNumber(row.totalTokens || 0)} tokens`,
          rows: rank(row => (row.totalCostUsd || 0) > 0, (a, b) => b.totalCostUsd - a.totalCostUsd),
        },
        {
          key: 'output',
          title: 'Low Output',
          metric: row => `${row.lowOutputCount || 0}`,
          detail: row => `${this.formatNumber(row.avgOutputChars || 0)} avg chars · ${this.formatNumber(row.doneCount || 0)} done`,
          rows: rank(row => (row.lowOutputCount || 0) > 0, (a, b) => b.lowOutputCount - a.lowOutputCount || a.avgOutputChars - b.avgOutputChars),
        },
        {
          key: 'toolsets',
          title: 'Oversized Toolsets',
          metric: row => `${row.oversizedToolsetCount || 0}`,
          detail: row => `${this.formatNumber(row.unusedAllowedToolCount || 0)} allowed tools went unused`,
          rows: rank(row => (row.oversizedToolsetCount || 0) > 0, (a, b) => b.oversizedToolsetCount - a.oversizedToolsetCount || b.unusedAllowedToolCount - a.unusedAllowedToolCount),
        },
        {
          key: 'workflows',
          title: 'Low-Value Workflow Steps',
          metric: row => `${(row.lowValueStepCount || 0) + (row.repeatedStepCount || 0)}`,
          detail: row => `${row.lowValueStepCount || 0} low-output · ${row.repeatedStepCount || 0} repeated`,
          rows: rank(row => row.type === 'workflow' && ((row.lowValueStepCount || 0) + (row.repeatedStepCount || 0)) > 0, (a, b) => ((b.lowValueStepCount || 0) + (b.repeatedStepCount || 0)) - ((a.lowValueStepCount || 0) + (a.repeatedStepCount || 0))),
        },
      ];
    },

    agentQualityToneClass(row) {
      if ((row.failedCount || 0) > 0 || (row.coachingScore || 0) >= 40) return 'text-red-400';
      if ((row.coachingScore || 0) >= 15) return 'text-yellow-400';
      return 'text-gray-400';
    },

    agentStatsWindowLabel(w) {
      return { today: 'Today', '7d': '7 days', '30d': '30 days', all: 'All time' }[w] || w;
    },
  },
};
