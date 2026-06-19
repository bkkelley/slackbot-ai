window.AppModules = window.AppModules || {};

window.AppModules.agents = {
  state() {
    return {
      agents: [],
      agentGroups: [],
      loadingAgents: false,
      selectedAgent: null,
      detailTab: 'overview',
      detailLoading: false,
      detailActions: [],
      detailJobs: [],
      detailShell: null,
      detailOverview: null,
      agentTimeline: [],
      agentTimelineLoading: false,
      agentTimelineError: '',
      showCreateAgent: false,
      creating: false,
      createError: '',
      newAgent: { name: '', instructions: '', model: 'claude-haiku-4-5-20251001', scope: '' },
      editTabs: ['Agent.md', 'CLAUDE.md', 'settings.json'],
      editTab: 'Agent.md',
      editFiles: {},
      editLoading: false,
      editSaving: false,
      editError: '',
      editSaved: false,
    };
  },

  methods: {
    async loadAgents() {
      this.loadingAgents = true;
      try {
        const r = await fetch('api/agents');
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Agents load failed');
        if (!Array.isArray(data)) throw new Error('Agents response was not a list');
        this.markApiOk();
        this.agents = data;
        const groupMap = {};
        for (const a of this.agents) {
          const key = a.scope || null;
          const label = key ? key : 'Global';
          if (!groupMap[label]) groupMap[label] = { scope: key, label, agents: [] };
          groupMap[label].agents.push(a);
        }
        this.agentGroups = Object.values(groupMap).sort((a, b) => {
          if (!a.scope) return -1;
          if (!b.scope) return 1;
          return a.label.localeCompare(b.label);
        });
      } catch (err) {
        console.error('agents load failed', err);
        this.reportApiError('Agents load failed', err);
        this.agents = [];
        this.agentGroups = [];
      } finally {
        this.loadingAgents = false;
      }
    },

    async loadJobs() {
      this.loadingJobs = true;
      try {
        const r = await fetch('api/jobs');
        this.jobs = await r.json();
      } catch (err) {
        console.error('jobs load failed', err);
        this.reportApiError('Jobs load failed', err);
        this.jobs = [];
      } finally {
        this.loadingJobs = false;
      }
    },

    startQueueRefresh() {
      this.loadQueue();
      this.stopQueueRefresh();
      this.queueTimer = setInterval(() => this.loadQueue(), 8000);
    },

    stopQueueRefresh() {
      if (this.queueTimer) { clearInterval(this.queueTimer); this.queueTimer = null; }
    },

    async loadQueue() {
      try {
        const r = await fetch('api/queue?limit=30');
        if (r.ok) {
          const data = await r.json();
          this.queue = data.jobs || [];
        }
      } catch {}
    },

    queueStatusColor(status) {
      return { pending: 'bg-yellow-500', running: 'bg-indigo-500 animate-pulse', done: 'bg-green-500', failed: 'bg-red-500' }[status] || 'bg-gray-500';
    },

    queueStatusText(status) {
      return { pending: 'pending', running: 'running', done: 'done', failed: 'failed' }[status] || status;
    },

    scopeParam(scope) {
      return scope ? '?scope=' + encodeURIComponent(scope) : '';
    },

    async selectAgent(agent) {
      this.selectedAgent = agent;
      this.agentMobileDetailOpen = true;
      this.detailTab = 'overview';
      this.detailLoading = true;
      this.detailActions = [];
      this.detailJobs = [];
      this.detailShell = null;
      this.detailOverview = null;
      this.agentTimeline = [];
      this.agentTimelineError = '';
      this.editFiles = {};
      this.editTabs = ['Agent.md', 'CLAUDE.md', 'settings.json'];
      this.editError = '';
      this.editSaved = false;
      const sp = this.scopeParam(agent.scope);
      try {
        const [actionsRes, shellRes, overviewRes] = await Promise.all([
          fetch(`api/agents/${agent.name}/actions${sp}`),
          fetch(`api/agents/${agent.name}/shell${sp}`),
          fetch(`api/agents/${agent.name}/overview${sp}`),
        ]);
        this.detailActions = await actionsRes.json();
        this.detailShell = await shellRes.json();
        this.detailOverview = await overviewRes.json();
        this.detailJobs = this.jobs.filter(j =>
          (j.agent && j.agent.toLowerCase() === agent.name.toLowerCase()) ||
          (j.command && j.command.toLowerCase().includes(agent.name.toLowerCase()))
        );
        await this.loadAgentTimeline(agent);
      } finally {
        this.detailLoading = false;
      }
    },

    async loadAgentTimeline(agent = this.selectedAgent) {
      if (!agent) return;
      this.agentTimelineLoading = true;
      this.agentTimelineError = '';
      try {
        const queueRes = await fetch('api/queue?limit=120');
        const queueData = await queueRes.json();
        if (!queueRes.ok) throw new Error(queueData.error || 'Queue load failed');

        const agentName = agent.name.toLowerCase();
        this.agentTimeline = (queueData.jobs || [])
          .filter(job =>
            (job.agent && job.agent.toLowerCase() === agentName) ||
            (job.command && job.command.toLowerCase().includes(agentName))
          )
          .map(job => ({
            id: `job:${job.id}`,
            type: 'job',
            title: job.action || job.command?.split('/').pop() || 'Job',
            detail: job.result?.error || job.trigger || job.id,
            time: job.completedAt || job.startedAt || job.createdAt,
            status: job.status,
            job,
          }))
          .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
          .slice(0, 30);
        this.markApiOk();
      } catch (err) {
        this.agentTimelineError = err.message;
        this.notify('Agent timeline failed to load', 'error');
      } finally {
        this.agentTimelineLoading = false;
      }
    },

    agentTimelineIcon(item) {
      return item.type === 'job' ? 'JOB' : 'LOG';
    },

    agentTimelineClass(item) {
      if (item.status === 'failed') return 'bg-red-500';
      if (item.status === 'running') return 'bg-indigo-500 animate-pulse';
      if (item.status === 'pending') return 'bg-yellow-500';
      return 'bg-green-500';
    },

    async loadDetailFiles() {
      if (Object.keys(this.editFiles).length > 0) return;
      this.editLoading = true;
      this.editTab = 'Agent.md';
      const sp = this.scopeParam(this.selectedAgent.scope);
      try {
        const r = await fetch(`api/agents/${this.selectedAgent.name}/files${sp}`);
        this.editFiles = await r.json();
        this.editTabs = Object.keys(this.editFiles);
        if (!this.editTabs.includes(this.editTab)) this.editTab = this.editTabs[0] || 'Agent.md';
      } catch (err) {
        this.editError = err.message;
        this.notify('Could not load config files', 'error');
      } finally {
        this.editLoading = false;
      }
    },

    async saveEditFile() {
      this.editError = '';
      this.editSaved = false;
      this.editSaving = true;
      const sp = this.scopeParam(this.selectedAgent.scope);
      try {
        const r = await fetch(`api/agents/${this.selectedAgent.name}/files${sp}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: this.editTab, content: this.editFiles[this.editTab].content }),
        });
        if (!r.ok) { this.editError = (await r.json()).error; return; }
        this.editSaved = true;
        this.notify('Config saved');
        setTimeout(() => { this.editSaved = false; }, 3000);
      } catch (err) {
        this.editError = err.message;
        this.notify('Config save failed', 'error');
      } finally {
        this.editSaving = false;
      }
    },

    openCreateAgent() {
      this.newAgent = { name: '', instructions: '', model: 'claude-haiku-4-5-20251001', scope: '' };
      this.createError = '';
      this.showCreateAgent = true;
    },

    async submitCreateAgent() {
      this.createError = '';
      if (!this.newAgent.name || !this.newAgent.instructions) {
        this.createError = 'Name and instructions are required.';
        return;
      }
      this.creating = true;
      try {
        const body = { ...this.newAgent };
        if (!body.scope) delete body.scope;
        const r = await fetch('api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) { this.createError = (await r.json()).error; return; }
        this.showCreateAgent = false;
        this.notify('Agent created');
        await this.loadAgents();
      } catch (err) {
        this.createError = err.message;
        this.notify('Agent creation failed', 'error');
      } finally {
        this.creating = false;
      }
    },

    async toggleAgentStatus(agent) {
      const newStatus = agent.status === 'Active' ? 'Inactive' : 'Active';
      const sp = this.scopeParam(agent.scope);
      await fetch(`api/agents/${agent.name}${sp}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      agent.status = newStatus;
      this.notify(`Agent ${newStatus === 'Active' ? 'enabled' : 'disabled'}`);
    },

    confirmDeleteAgent(agent) {
      this.confirmDelete = {
        show: true,
        name: agent.name,
        action: async () => {
          const sp = this.scopeParam(agent.scope);
          await fetch(`api/agents/${agent.name}${sp}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ removeWorkspace: false }),
          });
          this.confirmDelete.show = false;
          this.selectedAgent = null;
          this.notify('Agent deleted');
          await this.loadAgents();
        }
      };
    },


  },
};
