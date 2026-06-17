window.AppModules = window.AppModules || {};

window.AppModules.ask = {
  state() {
    return {
      askInitialized: false,
      askAgentKey: '',
      askAgentName: '',
      askAgentScope: null,
      askActionName: '',
      askActions: [],
      askToolset: '',
      askFiles: '',
      askMessage: '',
      askSessionId: 'ask-the-system',
      askTurns: [],
      askRunning: false,
      askError: '',
      askEs: null,
      askJobId: null,
    };
  },

  methods: {
    initAskTab() {
      if (this.askInitialized) return;
      this.askInitialized = true;
      const systemAgent = (this.agents || []).find((agent) => agent.name === 'Ask the System');
      const firstAgent = systemAgent || (this.agents || [])[0];
      if (firstAgent) {
        this.askAgentName = firstAgent.name;
        this.askAgentScope = firstAgent.scope || null;
        this.askAgentKey = this.composeAskAgentKey(this.askAgentScope, this.askAgentName);
      }
      this.askActionName = this.askAgentName === 'Ask the System' ? 'Diagnose' : '';
      this.askSessionId = this.defaultAskSessionId();
      this.loadAskActions();
    },

    composeAskAgentKey(scope, name) {
      return `${scope || ''}::${name || ''}`;
    },

    parseAskAgentKey(value) {
      const sep = value.indexOf('::');
      return {
        scope: sep >= 0 && value.slice(0, sep) ? value.slice(0, sep) : null,
        name: sep >= 0 ? value.slice(sep + 2) : value,
      };
    },

    onAskAgentChange(value) {
      const parsed = this.parseAskAgentKey(value || '');
      this.askAgentName = parsed.name;
      this.askAgentScope = parsed.scope;
      this.askAgentKey = value;
      this.askActionName = this.askAgentName === 'Ask the System' ? 'Diagnose' : '';
      this.askSessionId = this.defaultAskSessionId();
      this.askTurns = [];
      this.askError = '';
      this.loadAskActions();
    },

    async loadAskActions() {
      this.askActions = [];
      if (!this.askAgentName) return;
      const sp = this.scopeParam(this.askAgentScope);
      try {
        const r = await fetch(`api/agents/${encodeURIComponent(this.askAgentName)}/actions${sp}`);
        const actions = await r.json();
        if (!r.ok) throw new Error(actions.error || 'Action load failed');
        this.askActions = Array.isArray(actions) ? actions : [];
        const hasCurrent = this.askActions.includes(this.askActionName);
        if (!hasCurrent) {
          const diagnose = this.askActions.find((action) => action === 'Diagnose');
          this.askActionName = (this.askAgentName === 'Ask the System' && diagnose)
            ? 'Diagnose'
            : (this.askActions[0] || '');
        }
        this.askSessionId = this.defaultAskSessionId();
      } catch (err) {
        this.askError = err.message;
        this.notify('Could not load ask actions', 'error');
      }
    },

    defaultAskSessionId() {
      const slug = [this.askAgentScope || 'global', this.askAgentName || 'agent', this.askActionName || 'action']
        .join(':')
        .toLowerCase()
        .replace(/[^a-z0-9:._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      return this.askAgentName === 'Ask the System' ? 'ask-the-system' : `ask:${slug}`;
    },

    selectedAskLabel() {
      const scope = this.askAgentScope ? `${this.askAgentScope} / ` : '';
      return `${scope}${this.askAgentName || 'No agent'}${this.askActionName ? ` / ${this.askActionName}` : ''}`;
    },

    newAskSession() {
      if (this.askEs) { this.askEs.close(); this.askEs = null; }
      this.askRunning = false;
      this.askJobId = null;
      this.askError = '';
      this.askTurns = [];
      this.askSessionId = `${this.defaultAskSessionId()}:${Date.now()}`;
      this.notify('Ask session reset');
    },

    clearAskTranscript() {
      this.askTurns = [];
      this.askError = '';
    },

    async submitAsk() {
      const text = this.askMessage.trim();
      if (!text || this.askRunning || !this.askAgentName || !this.askActionName) return;

      this.askError = '';
      this.askMessage = '';
      const now = new Date().toISOString();
      const userTurn = { id: `user:${Date.now()}`, role: 'user', text, createdAt: now };
      const assistantTurn = {
        id: `assistant:${Date.now()}`,
        role: 'assistant',
        text: '',
        events: [],
        status: 'running',
        jobId: null,
        createdAt: now,
      };
      this.askTurns.push(userTurn, assistantTurn);
      this.askRunning = true;
      this.askJobId = null;

      const body = {
        agentName: this.askAgentName,
        actionName: this.askActionName,
        replyText: text,
        sessionId: this.askSessionId || this.defaultAskSessionId(),
        noSlack: true,
        ...(this.askAgentScope ? { scope: this.askAgentScope } : {}),
        ...(this.askToolset ? { toolset: this.askToolset } : {}),
      };
      if (this.askFiles.trim()) {
        body.files = this.askFiles.split(',').map((file) => file.trim()).filter(Boolean);
      }

      try {
        const r = await fetch('api/dispatch/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const result = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(result.error || 'Dispatch failed');
        if (!result.jobId) throw new Error('No job ID returned from dispatch');
        assistantTurn.jobId = result.jobId;
        this.askJobId = result.jobId;
        this.streamAskJob(result.jobId, assistantTurn);
      } catch (err) {
        assistantTurn.status = 'failed';
        assistantTurn.text = `Error: ${err.message}`;
        this.askError = err.message;
        this.askRunning = false;
        this.reportApiError('Ask dispatch failed', err);
      } finally {
        this.scrollAskTranscript();
      }
    },

    streamAskJob(jobId, assistantTurn) {
      if (this.askEs) { this.askEs.close(); this.askEs = null; }
      const es = new EventSource(`api/queue/${jobId}/stream`);
      this.askEs = es;

      es.onmessage = (e) => {
        let evt;
        try { evt = JSON.parse(e.data); } catch { return; }

        if (evt.type === 'text' && evt.text) {
          assistantTurn.text += evt.text;
        } else if (evt.type === 'tool') {
          const label = this.formatAskToolLine(evt.tool, evt.input);
          if (label) assistantTurn.events.push({ id: `${Date.now()}:${assistantTurn.events.length}`, label });
          if (evt.tool === 'PostMessage' && evt.input?.text) {
            const message = String(evt.input.text).trim();
            if (message && !assistantTurn.text.includes(message)) {
              assistantTurn.text += (assistantTurn.text.trim() ? '\n\n' : '') + message;
            }
          }
        } else if (evt.type === 'status' && (evt.status === 'done' || evt.status === 'failed')) {
          this.finishAskStream(es, assistantTurn, evt.status === 'done' && evt.result?.ok !== false, evt.result?.error);
        } else if (evt.type === 'done') {
          this.finishAskStream(es, assistantTurn, evt.status !== 'failed' && evt.result?.ok !== false, evt.result?.error);
        } else if (evt.type === 'error') {
          this.finishAskStream(es, assistantTurn, false, evt.message);
        }

        this.scrollAskTranscript();
      };

      es.onerror = async () => {
        if (!this.askRunning) { es.close(); this.askEs = null; return; }
        es.close();
        this.askEs = null;
        try {
          const r = await fetch(`api/queue/${jobId}`);
          const job = await r.json();
          if (job.result?.textOutput && !assistantTurn.text.trim()) assistantTurn.text = job.result.textOutput;
          if (job.status === 'done' || job.status === 'failed') {
            this.finishAskStream(null, assistantTurn, job.status === 'done' && job.result?.ok !== false, job.result?.error);
          } else {
            assistantTurn.status = 'running';
            assistantTurn.events.push({ id: `${Date.now()}:background`, label: 'Job is still running in the Jobs tab.' });
            this.askRunning = false;
          }
        } catch (err) {
          this.finishAskStream(null, assistantTurn, false, 'Stream disconnected; check the Jobs tab for status.');
        }
      };
    },

    finishAskStream(es, assistantTurn, ok, error) {
      if (es) es.close();
      if (this.askEs === es) this.askEs = null;
      assistantTurn.status = ok ? 'done' : 'failed';
      if (!assistantTurn.text.trim() && error) assistantTurn.text = `Error: ${error}`;
      if (!assistantTurn.text.trim()) assistantTurn.text = ok ? 'Done.' : 'The job finished without a text reply.';
      this.askRunning = false;
      this.askError = ok ? '' : (error || 'Ask job failed');
      this.loadQueue();
      this.scrollAskTranscript();
    },

    scrollAskTranscript() {
      this.$nextTick(() => {
        const el = this.$refs.askTranscript;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },

    formatAskToolLine(tool, input) {
      if (!tool) return null;
      if (tool === 'PostMessage' && input?.text) return `Reply prepared: ${String(input.text).slice(0, 120)}`;
      if (tool === 'SpawnAgent' && input?.agent) return `Spawned ${input.agent} / ${input.action || '?'}`;
      if ((tool === 'WriteCard' || tool === 'UpdateCard') && input?.yaml) {
        const titleMatch = String(input.yaml).match(/^title:\s*(.+)/m);
        return `${tool}: ${titleMatch ? titleMatch[1] : 'card'}`;
      }
      if (tool === 'GetJobStatus' && input?.jobId) return `Checked job ${input.jobId}`;
      if (tool === 'WaitForJob' && input?.jobId) return `Waited for job ${input.jobId}`;
      return tool;
    },
  },
};
