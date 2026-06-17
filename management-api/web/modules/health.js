window.AppModules = window.AppModules || {};

window.AppModules.health = {
  state() {
    return {
      health: null,
      healthLoading: false,
      healthError: '',
      healthActionRunning: {},
    };
  },

  methods: {
    async loadHealth() {
      this.healthLoading = true;
      this.healthError = '';
      try {
        const r = await fetch('api/health');
        const data = await r.json();
        if (!r.ok) { this.healthError = data.error || 'Health check failed'; return; }
        this.markApiOk();
        this.health = data;
      } catch (err) {
        this.healthError = err.message;
        this.reportApiError('Health check failed', err);
      } finally {
        this.healthLoading = false;
      }
    },

    healthStatusClass(ok) {
      return ok ? 'bg-green-500' : 'bg-red-500';
    },

    healthIncidentTone(severity) {
      return {
        critical: 'border-red-900 bg-red-950/20',
        warning: 'border-yellow-900 bg-yellow-950/20',
        info: 'border-gray-800 bg-gray-900',
      }[severity] || 'border-gray-800 bg-gray-900';
    },

    healthIncidentDot(severity) {
      return {
        critical: 'bg-red-500',
        warning: 'bg-yellow-500',
        info: 'bg-indigo-500',
      }[severity] || 'bg-gray-500';
    },

    healthIncidentLabel(severity) {
      return {
        critical: 'Critical',
        warning: 'Warning',
        info: 'Info',
      }[severity] || severity;
    },

    healthIncidentMeta(incident) {
      const parts = [];
      if (incident.lastSeen) parts.push(`Last seen ${this.formatDate(incident.lastSeen)}`);
      if (incident.firstSeen && incident.firstSeen !== incident.lastSeen) parts.push(`First seen ${this.formatDate(incident.firstSeen)}`);
      if (incident.occurrenceCount) parts.push(`${this.formatNumber(incident.occurrenceCount)} occurrence${incident.occurrenceCount === 1 ? '' : 's'}`);
      return parts.join(' · ');
    },

    healthIncidentCardText(incident) {
      if (incident.incidentCard) return `Card: ${incident.incidentCard}`;
      if (incident.cardWriteError) return `Card write failed: ${incident.cardWriteError}`;
      if ((incident.occurrenceCount || 0) >= 2 && incident.severity !== 'info') return 'Card will be written on next recurrence';
      return '';
    },

    healthActionKey(incident, action) {
      return `${incident.id}:${action.type}:${action.target}`;
    },

    async runHealthAction(incident, action) {
      if (action.type === 'navigate') {
        this.navigate(action.target);
        return;
      }
      if (action.type === 'log') {
        this.openHealthLog(action.target);
        return;
      }
      if (action.type !== 'api') return;

      const key = this.healthActionKey(incident, action);
      this.healthActionRunning[key] = true;
      try {
        const data = await this.apiJson(
          `api/health/actions/${encodeURIComponent(action.target)}`,
          { method: 'POST' },
          'Health action failed'
        );
        this.notify(data.message || 'Health action completed');
        await this.loadHealth();
      } catch {
        // apiJson already reports the error.
      } finally {
        this.healthActionRunning[key] = false;
      }
    },

    openHealthRelatedLog(log) {
      this.openHealthLog(log.target || log.label);
    },

    healthActionClass(action) {
      if (action.variant === 'danger') return 'border-red-800 text-red-300 hover:border-red-600 hover:text-red-200';
      if (action.type === 'api') return 'border-indigo-800 text-indigo-300 hover:border-indigo-600 hover:text-indigo-200';
      return 'border-gray-800 text-gray-400 hover:border-gray-600 hover:text-white';
    },

    openHealthLog(label) {
      this.navigate('logs');
      this.$nextTick(async () => {
        await this.loadAvailableLogs();
        const log = this.availableLogs.find(item => item.name === label || item.label === label);
        if (log) this.selectLog(log);
      });
    },

    openHealthPath(key) {
      if (!this.health?.paths?.[key]) return;
      this.navigate('files');
      this.$nextTick(async () => {
        await this.loadFileRoots();
        const pathValue = this.healthFilePathFor(key);
        await this.loadFiles(pathValue);
      });
    },

    healthFilePathFor(key) {
      const item = this.health?.paths?.[key];
      if (!item) return '';
      if (key === 'vaultPath') {
        this.fileRoot = 'vault';
        return '';
      }
      if (key === 'baseDirectory') {
        this.fileRoot = 'workspaces';
        return '';
      }
      if (key === 'inbox') {
        this.fileRoot = 'vault';
        const vaultRoot = this.health?.paths?.vaultPath?.path || '';
        if (vaultRoot && item.path && item.path.startsWith(vaultRoot)) {
          return item.path.slice(vaultRoot.length).replace(/^\/+/, '');
        }
        return 'Inbox';
      }
      return '';
    },
  },
};
