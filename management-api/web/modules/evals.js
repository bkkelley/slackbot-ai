window.AppModules = window.AppModules || {};

window.AppModules.evals = {
  state() {
    return {
      evals: [],
      evalsPath: '',
      evalsLoading: false,
      evalsRunning: false,
      evalRunId: null,
      evalsError: '',
      showEvalForm: false,
      evalFormSaving: false,
      evalFormError: '',
      evalForm: {},
    };
  },

  methods: {
    async loadEvals() {
      this.evalsLoading = true;
      this.evalsError = '';
      try {
        const data = await this.apiJson('api/evals', {}, 'Evals load failed');
        this.evals = data.evals || [];
        this.evalsPath = data.path || '';
      } catch (err) {
        this.evalsError = err.message;
      } finally {
        this.evalsLoading = false;
      }
    },

    async openEvalForm(evalCase = null) {
      this.evalFormError = '';
      this.evalForm = evalCase ? {
        ...evalCase,
        _isEdit: true,
        requiredToolsText: (evalCase.requiredTools || []).join(', '),
      } : {
        id: '',
        _isEdit: false,
        name: '',
        agent: this.selectedAgent?.name || '',
        action: '',
        scope: this.selectedAgent?.scope || '',
        toolset: 'vault-readonly',
        inputText: '',
        expectedText: '',
        forbiddenText: '',
        requiredToolsText: 'WriteCard',
        minOutputChars: 80,
        requireCard: true,
        requireMessage: false,
        enabled: true,
      };
      await this.ensureEvalFormCatalogs();
      this.showEvalForm = true;
    },

    closeEvalForm() {
      this.showEvalForm = false;
      this.evalForm = {};
      this.evalFormError = '';
    },

    evalPayload() {
      const { _isEdit, requiredToolsText, ...payload } = this.evalForm;
      return {
        ...payload,
        scope: payload.scope || null,
        requiredTools: String(this.evalForm.requiredToolsText || '')
          .split(',')
          .map(tool => tool.trim())
          .filter(Boolean),
      };
    },

    async saveEvalForm() {
      this.evalFormError = '';
      this.evalFormSaving = true;
      try {
        const isEdit = Boolean(this.evalForm._isEdit);
        const url = isEdit ? `api/evals/${encodeURIComponent(this.evalForm.id)}` : 'api/evals';
        const method = isEdit ? 'PUT' : 'POST';
        await this.apiJson(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.evalPayload()),
        }, 'Eval save failed');
        this.notify(isEdit ? 'Eval saved' : 'Eval created');
        this.closeEvalForm();
        await this.loadEvals();
      } catch (err) {
        this.evalFormError = err.message;
      } finally {
        this.evalFormSaving = false;
      }
    },

    async ensureEvalFormCatalogs() {
      const loads = [];
      if (!this.agentGroups.length && !this.loadingAgents) loads.push(this.loadAgents());
      if (!this.actionGroups.length && !this.loadingActions) loads.push(this.loadActions());
      if (!this.projects.length && !this.loadingProjects) loads.push(this.loadProjects());
      if (!this.toolsets.length && !this.loadingToolsets) loads.push(this.loadToolsets());
      if (!this.availableTools && !this.loadingTools) loads.push(this.loadTools());
      if (loads.length) {
        try { await Promise.all(loads); } catch {}
      }
    },

    evalIncludeCurrentOption(options, current, scope = null) {
      const value = String(current || '').trim();
      if (!value || options.some(option => option.name === value)) return options;
      return [{ name: value, label: `${value} (not found)`, scope }, ...options];
    },

    evalScopeOptions() {
      const options = [{ value: '', label: 'Global' }];
      for (const project of this.projects || []) {
        options.push({ value: project.name, label: project.name });
      }
      const current = String(this.evalForm.scope || '').trim();
      if (current && !options.some(option => option.value === current)) {
        options.push({ value: current, label: `${current} (not found)` });
      }
      return options;
    },

    evalAgentOptions() {
      const scope = this.evalForm.scope || null;
      const options = (this.agents || [])
        .filter(agent => (agent.scope || null) === scope)
        .map(agent => ({ name: agent.name, label: agent.name, scope: agent.scope || null }))
        .sort((a, b) => a.label.localeCompare(b.label));
      return this.evalIncludeCurrentOption(options, this.evalForm.agent, scope);
    },

    evalActionOptions() {
      const scope = this.evalForm.scope || null;
      const agentName = this.evalForm.agent || '';
      if (!agentName) return this.evalIncludeCurrentOption([], this.evalForm.action, scope);
      const group = (this.actionGroups || []).find(item => (item.scope || null) === scope);
      const agent = group?.agents?.find(item => item.name.toLowerCase() === agentName.toLowerCase());
      const options = (agent?.actions || [])
        .map(action => ({ name: action.name, label: action.name, scope }))
        .sort((a, b) => a.label.localeCompare(b.label));
      return this.evalIncludeCurrentOption(options, this.evalForm.action, scope);
    },

    evalToolsetOptions() {
      const options = (this.toolsets || [])
        .map(toolset => ({ name: toolset.name, label: toolset.name }))
        .sort((a, b) => a.label.localeCompare(b.label));
      return this.evalIncludeCurrentOption(options, this.evalForm.toolset);
    },

    evalAvailableToolOptions() {
      const names = new Set();
      for (const tool of this.availableTools?.sdkTools || []) names.add(tool.name);
      for (const tool of this.availableTools?.agentRuntimeTools || []) names.add(tool.name);
      for (const server of Object.keys(this.availableTools?.mcpServers || {})) names.add(`mcp__${server}__*`);
      for (const server of Object.keys(this.availableTools?.projectMcpServers || {})) names.add(`mcp__${server}__*`);
      return Array.from(names).sort((a, b) => a.localeCompare(b));
    },

    onEvalScopeChange() {
      this.evalForm.agent = '';
      this.evalForm.action = '';
    },

    onEvalAgentChange() {
      this.evalForm.action = '';
    },

    addEvalRequiredTool(tool) {
      const value = String(tool || '').trim();
      if (!value) return;
      const tools = String(this.evalForm.requiredToolsText || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
      if (!tools.includes(value)) tools.push(value);
      this.evalForm.requiredToolsText = tools.join(', ');
    },

    async deleteEval(evalCase) {
      if (!confirm(`Delete eval "${evalCase.name}"?`)) return;
      try {
        await this.apiJson(`api/evals/${encodeURIComponent(evalCase.id)}`, { method: 'DELETE' }, 'Eval delete failed');
        this.notify('Eval deleted');
        await this.loadEvals();
      } catch (err) {
        this.notify(err.message, 'error');
      }
    },

    async runEval(evalCase) {
      this.evalRunId = evalCase.id;
      try {
        const data = await this.apiJson(`api/evals/${encodeURIComponent(evalCase.id)}/run`, { method: 'POST' }, 'Eval run failed');
        this.notify(data.run?.passed ? 'Eval passed' : 'Eval failed', data.run?.passed ? 'info' : 'error');
        await this.loadEvals();
      } catch (err) {
        this.notify(err.message, 'error');
      } finally {
        this.evalRunId = null;
      }
    },

    async runEnabledEvals() {
      this.evalsRunning = true;
      try {
        const data = await this.apiJson('api/evals/run-enabled', { method: 'POST' }, 'Eval suite failed');
        const failed = (data.results || []).filter(item => !item.run?.passed).length;
        this.notify(failed ? `${failed} evals failed` : 'All enabled evals passed', failed ? 'error' : 'info');
        await this.loadEvals();
      } catch (err) {
        this.notify(err.message, 'error');
      } finally {
        this.evalsRunning = false;
      }
    },

    evalStatusClass(evalCase) {
      if (!evalCase.lastRun) return 'border-gray-800 text-gray-500 bg-gray-950';
      return evalCase.lastRun.passed
        ? 'border-emerald-900/70 text-emerald-300 bg-emerald-950/30'
        : 'border-red-900/70 text-red-300 bg-red-950/30';
    },

    evalStatusText(evalCase) {
      if (!evalCase.lastRun) return 'never run';
      return evalCase.lastRun.passed ? 'passed' : 'failed';
    },

    evalCheckSummary(evalCase) {
      const checks = evalCase.lastRun?.checks || [];
      if (!checks.length) return 'No checks recorded.';
      const passed = checks.filter(check => check.passed).length;
      return `${passed}/${checks.length} checks passed`;
    },
  },
};
