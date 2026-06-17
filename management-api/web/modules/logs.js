window.AppModules = window.AppModules || {};

window.AppModules.logs = {
  state() {
    return {
      availableLogs: [],
      selectedLog: null,
      selectedLogLabel: '',
      logLines: [],
      logFilter: '',
      logLevelFilter: 'all',
      logPaused: false,
      logConnecting: false,
      logConnected: false,
      logEs: null,
    };
  },

  methods: {
    async loadAvailableLogs() {
      try {
        const r = await fetch('api/logs');
        this.availableLogs = await r.json();
        this.markApiOk();
      } catch (err) {
        console.error('failed to load logs list', err);
        this.reportApiError('Logs list load failed', err);
      }
    },

    logGroups() {
      return [
        { label: 'System', logs: this.availableLogs.filter(log => log.type !== 'agent') },
        { label: 'Agents', logs: this.availableLogs.filter(log => log.type === 'agent') },
      ];
    },

    selectLog(log) {
      if (this.logEs) { this.logEs.close(); this.logEs = null; }
      this.selectedLog = log.name;
      this.selectedLogLabel = log.type === 'agent' ? `Agent / ${log.label || log.agent}` : (log.label || log.name);
      this.logMobileDetailOpen = true;
      this.logLines = [];
      this.logFilter = '';
      this.logLevelFilter = 'all';
      this.logPaused = false;
      this.logConnecting = true;
      this.logConnected = false;

      const params = log.type === 'agent'
        ? `agent=${encodeURIComponent(log.agent)}&lines=100`
        : `log=${encodeURIComponent(log.name)}&lines=100`;
      const es = new EventSource(`api/logs/stream?${params}`);
      this.logEs = es;

      es.onopen = () => {
        this.logConnecting = false;
        this.logConnected = true;
      };

      es.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          this.logLines.push(data.line || evt.data);
        } catch {
          this.logLines.push(evt.data);
        }
        if (!this.logPaused) this.$nextTick(() => {
          const el = this.$refs.logOutput;
          if (el) el.scrollTop = el.scrollHeight;
        });
      };

      es.onerror = () => {
        const wasConnected = this.logConnected;
        this.logConnecting = false;
        this.logConnected = false;
        if (wasConnected) this.notify('Log stream disconnected', 'error');
      };
    },

    clearLogDisplay() {
      this.logLines = [];
    },

    logLineClass(line) {
      if (this.isErrorLogLine(line)) return 'text-red-400';
      if (this.isSuccessLogLine(line)) return 'text-green-400';
      return 'text-gray-400';
    },

    displayLogLine(line) {
      try {
        const parsed = JSON.parse(line);
        return JSON.stringify(parsed, null, 2);
      } catch {
        return line;
      }
    },

    logJobId(line) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.jobId) return parsed.jobId;
      } catch {}
      const match = String(line).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      return match ? match[0] : null;
    },

    isErrorLogLine(line) {
      return /error|failed|fatal|exception/i.test(line);
    },

    isSuccessLogLine(line) {
      return /\bok\b|completed|success|done/i.test(line);
    },

    filteredLogLines() {
      const q = this.logFilter.trim().toLowerCase();
      return this.logLines.filter(line => {
        if (this.logLevelFilter === 'error' && !this.isErrorLogLine(line)) return false;
        if (this.logLevelFilter === 'success' && !this.isSuccessLogLine(line)) return false;
        return !q || line.toLowerCase().includes(q);
      });
    },

    async copyVisibleLogLines() {
      const text = this.filteredLogLines().join('\n');
      if (!text) {
        this.notify('No visible log lines to copy', 'error');
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        const count = this.filteredLogLines().length;
        this.notify(`Copied ${count} log line${count === 1 ? '' : 's'}`);
      } catch (err) {
        this.notify('Could not copy log lines', 'error');
      }
    },
  },
};
