window.AppModules = window.AppModules || {};

window.AppModules.jobs = {
  state() {
    return {
      jobs: [],
      loadingJobs: true,
      showCreateJob: false,
      newJob: {},
      creatingJob: false,
      createJobError: '',
      showEditJob: false,
      editJob: {},
      editJobSaving: false,
      editJobError: '',
      schedulePresets: [
        { label: 'Every 15 min', cron: '*/15 * * * *' },
        { label: 'Every 30 min', cron: '*/30 * * * *' },
        { label: 'Hourly',       cron: '0 * * * *' },
        { label: 'Daily',        cron: null },
        { label: 'Weekly',       cron: null },
        { label: 'Monthly',      cron: null },
      ],
      queue: [],
      queueLoading: false,
      queueTimer: null,
      schedulePreviewCount: 3,
      schedulePreviewCache: {},
    };
  },

  methods: {
    async toggleJob(job) {
      await fetch(`api/jobs/${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !job.enabled }),
      });
      job.enabled = !job.enabled;
      this.notify(`Job ${job.enabled ? 'enabled' : 'disabled'}`);
    },

    confirmDeleteJob(job) {
      this.confirmDelete = {
        show: true,
        name: job.id,
        action: async () => {
          await fetch(`api/jobs/${job.id}`, { method: 'DELETE' });
          this.confirmDelete.show = false;
          this.notify('Job deleted');
          await this.loadJobs();
        }
      };
    },

    openCreateJob() {
      this.newJob = { id: '', description: '', cron: '', command: '', slackChannel: '', toolset: 'default', schedulePreset: null, scheduleHour: 8, scheduleMinute: 0, scheduleDay: 1, scheduleDom: 1, customCommand: false, agentName: '', agentAction: '', agentActions: [] };
      this.createJobError = '';
      this.showCreateJob = true;
    },

    async loadAgentActions() {
      this.newJob.agentAction = '';
      this.newJob.agentActions = [];
      this.newJob.command = '';
      if (!this.newJob.agentName) return;
      try {
        const r = await fetch(`api/agents/${this.newJob.agentName}/actions`);
        this.newJob.agentActions = await r.json();
      } catch {}
    },

    buildJobCommand() {
      if (this.newJob.agentName && this.newJob.agentAction) {
        this.newJob.command = '';
        if (!this.newJob.id) {
          this.newJob.id = `${this.newJob.agentName.toLowerCase()}-${this.newJob.agentAction.toLowerCase().replace(/\s+/g, '-')}`;
        }
      }
    },

    async submitCreateJob() {
      this.createJobError = '';
      const useAgent = !this.newJob.customCommand && this.newJob.agentName && this.newJob.agentAction;
      if (!this.newJob.id || !this.newJob.cron || (!useAgent && !this.newJob.command)) {
        this.createJobError = 'ID, schedule, and command (or agent + action) are required.';
        return;
      }
      const scheduleError = this.schedulePreviewError(this.newJob);
      if (this.shouldBlockScheduleSave(this.newJob, scheduleError)) {
        this.createJobError = `Schedule is invalid: ${scheduleError}`;
        return;
      }
      this.creatingJob = true;
      try {
        const body = { id: this.newJob.id, description: this.newJob.description || null, cron: this.newJob.cron, enabled: true };
        if (useAgent) {
          body.agent = this.newJob.agentName;
          body.action = this.newJob.agentAction;
          body.mode = 'async';
          body.toolset = this.newJob.toolset || 'default';
          if (this.newJob.slackChannel) body.outputChannel = { platform: 'slack', id: this.newJob.slackChannel };
        } else {
          body.command = this.newJob.command;
        }
        const r = await fetch('api/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) { this.createJobError = (await r.json()).error; return; }
        this.showCreateJob = false;
        this.notify('Job created');
        await this.loadJobs();
      } catch (err) {
        this.createJobError = err.message;
        this.notify('Job creation failed', 'error');
      } finally {
        this.creatingJob = false;
      }
    },

    openEditJob(job) {
      this.editJob = { ...job, schedulePreset: this.detectPreset(job.cron), ...this.cronParts(job.cron) };
      this.editJobError = '';
      this.showEditJob = true;
    },

    detectPreset(cron) {
      if (!cron) return 'Custom';
      if (cron === '*/15 * * * *') return 'Every 15 min';
      if (cron === '*/30 * * * *') return 'Every 30 min';
      if (cron === '0 * * * *') return 'Hourly';
      if (/^\d+ \d+ \* \* \*$/.test(cron)) return 'Daily';
      if (/^\d+ \d+ \* \* [0-7]$/.test(cron)) return 'Weekly';
      if (/^\d+ \d+ \d+ \* \*$/.test(cron)) return 'Monthly';
      return 'Custom';
    },

    applyPreset(preset) { this.applyPresetTo(this.editJob, preset); },

    applyPresetTo(job, preset) {
      job.schedulePreset = preset.label;
      if (preset.cron) { job.cron = preset.cron; } else { this.rebuildCronFor(job); }
    },

    rebuildCron() { this.rebuildCronFor(this.editJob); },

    rebuildCronFor(job) {
      const h = job.scheduleHour ?? 8;
      const m = job.scheduleMinute ?? 0;
      const d = job.scheduleDay ?? 1;
      const dom = job.scheduleDom ?? 1;
      if (job.schedulePreset === 'Daily')   job.cron = `${m} ${h} * * *`;
      if (job.schedulePreset === 'Weekly')  job.cron = `${m} ${h} * * ${d}`;
      if (job.schedulePreset === 'Monthly') job.cron = `${m} ${h} ${dom} * *`;
    },

    async saveEditJob() {
      this.editJobError = '';
      const scheduleError = this.schedulePreviewError(this.editJob);
      if (this.shouldBlockScheduleSave(this.editJob, scheduleError)) {
        this.editJobError = `Schedule is invalid: ${scheduleError}`;
        return;
      }
      this.editJobSaving = true;
      try {
        const r = await fetch(`api/jobs/${this.editJob.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cron: this.editJob.cron,
            command: this.editJob.command,
            enabled: this.editJob.enabled,
            description: this.editJob.description || null,
            outputChannel: this.editJob.outputChannel,
          }),
        });
        if (!r.ok) { this.editJobError = (await r.json()).error; return; }
        this.showEditJob = false;
        this.notify('Job saved');
        await this.loadJobs();
        if (this.selectedAgent) {
          this.detailJobs = this.jobs.filter(j =>
            (j.agent && j.agent.toLowerCase() === this.selectedAgent.name.toLowerCase()) ||
            (j.command && j.command.toLowerCase().includes(this.selectedAgent.name.toLowerCase()))
          );
        }
      } catch (err) {
        this.editJobError = err.message;
        this.notify('Job save failed', 'error');
      } finally {
        this.editJobSaving = false;
      }
    },

    localTimezoneLabel() {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
    },

    cronParts(cron) {
      const parts = String(cron || '').trim().split(/\s+/);
      const fallback = { scheduleHour: 8, scheduleMinute: 0, scheduleDay: 1, scheduleDom: 1 };
      if (parts.length !== 5) return fallback;
      const minute = Number(parts[0]);
      const hour = Number(parts[1]);
      const dom = Number(parts[2]);
      const dow = Number(parts[4]);
      return {
        scheduleMinute: Number.isInteger(minute) ? minute : 0,
        scheduleHour: Number.isInteger(hour) ? hour : 8,
        scheduleDom: Number.isInteger(dom) ? dom : 1,
        scheduleDay: Number.isInteger(dow) ? (dow === 7 ? 0 : dow) : 1,
      };
    },

    scheduleSummary(job) {
      if (!job?.cron) return job?.runAt ? `Once at ${this.formatDate(job.runAt)}` : 'No schedule';
      const next = this.nextRuns(job.cron, 1);
      if (next.error?.includes('Preview unavailable')) return next.error;
      if (next.error === 'No run within the next year') return next.error;
      if (next.error) return `Invalid cron: ${next.error}`;
      if (!next.runs.length) return 'No upcoming run found';
      return `Next: ${this.formatDateTime(next.runs[0])}`;
    },

    schedulePreview(job) {
      if (!job?.cron) return [];
      const next = this.nextRuns(job.cron, this.schedulePreviewCount);
      return next.runs || [];
    },

    schedulePreviewError(job) {
      if (!job?.cron) return '';
      return this.nextRuns(job.cron, 1).error || '';
    },

    shouldBlockScheduleSave(job, error) {
      if (!error) return false;
      if (job.schedulePreset !== 'Custom') return true;
      return !error.includes('Preview unavailable') && error !== 'No run within the next year';
    },

    schedulePreviewMessageClass(job) {
      return this.shouldBlockScheduleSave(job, this.schedulePreviewError(job))
        ? 'text-xs text-red-400'
        : 'text-xs text-yellow-500/80';
    },

    formatDateTime(date) {
      return new Intl.DateTimeFormat(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(date);
    },

    nextRuns(cron, count = 3) {
      const cacheKey = `${String(cron || '').trim()}|${count}|${new Date().toISOString().slice(0, 16)}`;
      if (this.schedulePreviewCache[cacheKey]) return this.schedulePreviewCache[cacheKey];
      const parsed = this.parseCron(cron);
      if (parsed.error) {
        this.schedulePreviewCache[cacheKey] = { runs: [], error: parsed.error };
        return this.schedulePreviewCache[cacheKey];
      }
      const runs = [];
      const cursor = new Date();
      cursor.setSeconds(0, 0);
      cursor.setMinutes(cursor.getMinutes() + 1);
      const maxMinutes = 366 * 24 * 60;
      for (let i = 0; i < maxMinutes && runs.length < count; i++) {
        if (this.cronMatchesDate(parsed, cursor)) runs.push(new Date(cursor));
        cursor.setMinutes(cursor.getMinutes() + 1);
      }
      this.schedulePreviewCache[cacheKey] = { runs, error: runs.length ? '' : 'No run within the next year' };
      return this.schedulePreviewCache[cacheKey];
    },

    parseCron(cron) {
      const parts = String(cron || '').trim().split(/\s+/);
      if (parts.length !== 5) return { error: 'Expected five fields: minute hour day month weekday' };
      const fields = [
        this.parseCronField(parts[0], 0, 59, 'minute'),
        this.parseCronField(parts[1], 0, 23, 'hour'),
        this.parseCronField(parts[2], 1, 31, 'day of month'),
        this.parseCronField(parts[3], 1, 12, 'month'),
        this.parseCronField(parts[4], 0, 7, 'weekday'),
      ];
      const bad = fields.find(field => field.error);
      if (bad) return { error: bad.error };
      return {
        minutes: fields[0],
        hours: fields[1],
        dom: fields[2],
        months: fields[3],
        dow: fields[4],
        error: '',
      };
    },

    parseCronField(raw, min, max, label) {
      const text = String(raw || '').trim();
      const values = new Set();
      if (text === '*') return { any: true, values, error: '' };
      for (const token of text.split(',')) {
        const stepParts = token.split('/');
        if (stepParts.length > 2) return { any: false, values, error: `${label} field is not supported` };
        const base = stepParts[0];
        const step = stepParts[1] ? Number(stepParts[1]) : 1;
        if (!Number.isInteger(step) || step < 1) return { any: false, values, error: `${label} has an invalid step` };

        if (base === '*') {
          if (!step || step < 1) return { any: false, values, error: `${label} has an invalid step` };
          for (let value = min; value <= max; value += step) values.add(value);
          continue;
        }

        const rangeMatch = base.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
          const start = Number(rangeMatch[1]);
          const end = Number(rangeMatch[2]);
          if (start > end || start < min || end > max) return { any: false, values, error: `${label} range is out of bounds` };
          for (let value = start; value <= end; value += step) values.add(value);
          continue;
        }

        if (/^\d+$/.test(base)) {
          const value = Number(base);
          if (value < min || value > max) return { any: false, values, error: `${label} is out of bounds` };
          values.add(value);
          continue;
        }

        return { any: false, values, error: `Preview unavailable for this ${label} field` };
      }
      return { any: false, values, error: values.size ? '' : `${label} is empty` };
    },

    cronFieldMatches(field, value, altValue = null) {
      if (field.any) return true;
      return field.values.has(value) || (altValue !== null && field.values.has(altValue));
    },

    cronMatchesDate(parsed, date) {
      if (!this.cronFieldMatches(parsed.minutes, date.getMinutes())) return false;
      if (!this.cronFieldMatches(parsed.hours, date.getHours())) return false;
      if (!this.cronFieldMatches(parsed.months, date.getMonth() + 1)) return false;

      const domMatch = this.cronFieldMatches(parsed.dom, date.getDate());
      const dowMatch = this.cronFieldMatches(parsed.dow, date.getDay(), date.getDay() === 0 ? 7 : null);
      if (parsed.dom.any && parsed.dow.any) return true;
      if (parsed.dom.any) return dowMatch;
      if (parsed.dow.any) return domMatch;
      return domMatch || dowMatch;
    },


  },
};
