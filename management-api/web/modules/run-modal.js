window.AppModules = window.AppModules || {};

window.AppModules.runModal = {
  state() {
    return {
      showRunModal: false,
      runForm: {
        agentName: '',
        agentScope: null,
        agentKey: '',
        actionName: '',
        agentActions: [],
        files: '',
        timeout: 15,
        noSlack: false,
        preview: false,
        toolset: '',
      },
      runStreaming: false,
      runRunning: false,
      runResult: null,
      runLines: [],
      runError: '',
      runEs: null,
      runJobId: null,
    };
  },

  methods: {
    openRunModal(agentName, actionName, agentScope) {
      const scope = agentScope !== undefined ? agentScope : (this.selectedAgent && this.selectedAgent.name === agentName ? this.selectedAgent.scope : null);
      this.runForm = {
        agentName: agentName || '',
        agentScope: scope || null,
        agentKey: agentName ? (scope || '') + '::' + agentName : '',
        actionName: actionName || '',
        agentActions: [],
        files: '',
        timeout: 15,
        noSlack: false,
        preview: false,
        toolset: '',
      };
      this.runStreaming = false;
      this.runRunning = false;
      this.runResult = null;
      this.runLines = [];
      this.runError = '';
      this.runJobId = null;
      this.showRunModal = true;

      if (agentName) {
        this.loadRunActions();
      }
    },

    onRunAgentChange(value) {
      if (!value) {
        this.runForm.agentName = '';
        this.runForm.agentScope = null;
        this.runForm.agentKey = '';
        this.runForm.agentActions = [];
        return;
      }
      const sep = value.indexOf('::');
      this.runForm.agentScope = sep >= 0 && value.slice(0, sep) ? value.slice(0, sep) : null;
      this.runForm.agentName = sep >= 0 ? value.slice(sep + 2) : value;
      this.runForm.agentKey = value;
      this.loadRunActions();
    },

    watchJob(jobId, agentName, actionName) {
      this.runForm = { agentName: agentName || '', actionName: actionName || '', agentActions: [], files: '', timeout: 15, dryRun: false, noSlack: false, preview: false };
      this.runStreaming = true;
      this.runRunning = true;
      this.runResult = null;
      this.runLines = [];
      this.runError = '';
      this.runJobId = jobId;
      this.showRunModal = true;
      this.streamJob(jobId);
    },

    closeRunModal() {
      if (this.runEs) { this.runEs.close(); this.runEs = null; }
      this.showRunModal = false;
      this.runStreaming = false;
      this.runRunning = false;
      this.runJobId = null;
    },

    async loadRunActions() {
      this.runForm.agentActions = [];
      if (!this.runForm.agentName) return;
      const sp = this.scopeParam(this.runForm.agentScope);
      try {
        const r = await fetch(`api/agents/${this.runForm.agentName}/actions${sp}`);
        this.runForm.agentActions = await r.json();
      } catch (err) {
        this.notify('Could not load run actions', 'error');
      }
    },

    async submitRun() {
      if (!this.runForm.agentName || !this.runForm.actionName) return;
      this.runError = '';
      this.runLines = [];
      this.runStreaming = true;
      this.runRunning = true;
      this.runResult = null;
      this.runJobId = null;

      const body = {
        agentName: this.runForm.agentName,
        actionName: this.runForm.actionName,
        noSlack: this.runForm.noSlack,
        mode: this.runForm.preview ? 'preview' : 'async',
        ...(this.runForm.agentScope ? { scope: this.runForm.agentScope } : {}),
        ...(this.runForm.toolset ? { toolset: this.runForm.toolset } : {}),
      };
      if (this.runForm.files.trim()) {
        body.files = this.runForm.files.split(',').map(s => s.trim()).filter(Boolean);
      }

      try {
        const r = await fetch('api/dispatch/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!r.ok) {
          const err = await r.json();
          this.runLines.push({ type: 'error', text: 'Error: ' + (err.error || 'Unknown error') });
          this.runRunning = false;
          return;
        }

        const result = await r.json();
        const jobId = result.jobId;
        if (!jobId) {
          this.runLines.push({ type: 'error', text: 'No job ID returned from dispatch' });
          this.runRunning = false;
          return;
        }
        this.runJobId = jobId;
        this.notify('Run started');
        this.streamJob(jobId);
      } catch (err) {
        this.runLines.push({ type: 'error', text: 'Connection error: ' + err.message });
        this.reportApiError('Run dispatch failed', err);
        this.runRunning = false;
      }
    },

    streamJob(jobId) {
      if (this.runEs) { this.runEs.close(); this.runEs = null; }
      const es = new EventSource(`api/queue/${jobId}/stream`);
      this.runEs = es;

      es.onmessage = (e) => {
        let evt;
        try { evt = JSON.parse(e.data); } catch { return; }

        if (evt.type === 'text' && evt.text) {
          // Split multi-line text into separate display lines
          const lines = evt.text.split('\n');
          for (const line of lines) {
            if (line.trim()) this.runLines.push({ type: 'text', text: line });
          }
        } else if (evt.type === 'tool') {
          const label = this.formatToolLine(evt.tool, evt.input);
          if (label) this.runLines.push({ type: 'tool', text: label });
        } else if (evt.type === 'status') {
          if (evt.status === 'done') {
            const res = evt.result || {};
            this.runResult = { ok: res.ok !== false };
            const cards = (res.cardFiles || []).map(f => f.split('/').pop()).join(', ');
            const msgs = (res.postedMessageIds || []).length;
            let summary = res.ok !== false ? '✓ Done' : '✗ Failed';
            if (res.preview) summary = `${res.ok !== false ? '✓ Preview passed' : '✗ Preview failed'} — ${res.preview.kind}${res.preview.promptChars !== undefined ? ` prompt: ${this.formatNumber(res.preview.promptChars)} chars` : ''}`;
            if (cards) summary += ` — cards: ${cards}`;
            if (msgs) summary += ` — ${msgs} message${msgs > 1 ? 's' : ''} posted`;
            if (res.error) summary += ` — ${res.error}`;
            this.runLines.push({ type: 'result', ok: res.ok !== false, text: summary });
            if (res.preview?.errors?.length) {
              for (const error of res.preview.errors) this.runLines.push({ type: 'error', text: 'Preview error: ' + error });
            }
            if (res.preview?.warnings?.length) {
              for (const warning of res.preview.warnings) this.runLines.push({ type: 'log', text: 'Preview warning: ' + warning });
            }
            this.notify(res.ok !== false ? 'Run completed' : 'Run failed', res.ok !== false ? 'info' : 'error');
            this.runRunning = false;
            es.close();
            this.runEs = null;
            this.loadQueue();
          } else if (evt.status === 'failed') {
            this.runResult = { ok: false };
            this.runLines.push({ type: 'result', ok: false, text: '✗ Failed' + (evt.result?.error ? ': ' + evt.result.error : '') });
            this.notify('Run failed', 'error');
            this.runRunning = false;
            es.close();
            this.runEs = null;
            this.loadQueue();
          }
        } else if (evt.type === 'done') {
          if (this.runResult === null) this.runResult = { ok: true };
          this.runRunning = false;
          es.close();
          this.runEs = null;
          this.loadQueue();
        } else if (evt.type === 'error') {
          this.runLines.push({ type: 'error', text: '⚠ ' + evt.message });
          this.runRunning = false;
          es.close();
          this.runEs = null;
        }

        this.$nextTick(() => {
          const el = this.$refs.runOutput;
          if (el) el.scrollTop = el.scrollHeight;
        });
      };

      es.onerror = async () => {
        if (!this.runRunning) { es.close(); this.runEs = null; return; }
        es.close();
        this.runEs = null;
        // Poll actual job status rather than assuming failure
        try {
          const r = await fetch(`api/queue/${jobId}`);
          const job = await r.json();
          if (job.status === 'done') {
            const res = job.result || {};
            this.runResult = { ok: res.ok !== false };
            const cards = (res.cardFiles || []).map(f => f.split('/').pop()).join(', ');
            let summary = res.ok !== false ? '✓ Done' : '✗ Failed';
            if (res.preview) summary = `${res.ok !== false ? '✓ Preview passed' : '✗ Preview failed'} — ${res.preview.kind}${res.preview.promptChars !== undefined ? ` prompt: ${this.formatNumber(res.preview.promptChars)} chars` : ''}`;
            if (cards) summary += ` — cards: ${cards}`;
            if (res.error) summary += ` — ${res.error}`;
            this.runLines.push({ type: 'result', ok: res.ok !== false, text: summary });
            this.loadQueue();
          } else if (job.status === 'failed') {
            this.runResult = { ok: false };
            const err = job.result?.error || '';
            this.runLines.push({ type: 'result', ok: false, text: '✗ Failed' + (err ? ': ' + err : '') });
            this.loadQueue();
          } else {
            // Still running — let the user know to check the Queue tab
            this.runLines.push({ type: 'text', text: '⏳ Job still running in background — check Queue tab for results' });
            this.runResult = { ok: true };
            this.loadQueue();
          }
        } catch {
          this.runLines.push({ type: 'error', text: 'Stream disconnected — check Queue tab for status' });
          this.runResult = null;
        }
        this.runRunning = false;
      };
    },

    formatToolLine(tool, input) {
      if (!tool) return null;
      const icons = {
        PostMessage: '📨',
        SpawnAgent: '🤖', WaitForJob: '⏳', GetJobStatus: '📊',
      };
      const icon = icons[tool] || '🔧';
      if (tool === 'PostMessage' && input?.text) {
        return `${icon} PostMessage: ${String(input.text).slice(0, 80)}`;
      }
      if (tool === 'SpawnAgent' && input?.agent) {
        return `${icon} SpawnAgent: ${input.agent} / ${input.action || '?'}`;
      }
      return `${icon} ${tool}`;
    },


  },
};
