function app() {
  return {
    toasts: [],
    apiOffline: false,
    apiErrorMessage: '',
    tab: 'overview',
    theme: document.documentElement.dataset.theme || 'light',
    // ---- Overview ----
    ...AppModules.overview.state(),

    // ---- Activity ----
    activity: [],
    activityLoading: false,
    activityTimer: null,

    // ---- Agents ----
    ...AppModules.agents.state(),

    // ---- Delete confirm ----
    confirmDelete: { show: false, name: '', action: () => {} },

    // ---- Jobs ----
    ...AppModules.jobs.state(),

    // ---- Approvals ----
    ...AppModules.approvals.state(),

    // ---- Channels ----
    ...AppModules.channels.state(),

    // ---- Logs ----
    ...AppModules.logs.state(),

    // ---- Inbox ----
    inboxFiles: [],
    inboxLoading: false,
    inboxTimer: null,
    inboxProcessingAll: false,

    // ---- Run modal ----
    ...AppModules.runModal.state(),

    // ---- Ask Agent ----
    ...AppModules.ask.state(),

    // ---- Workflows ----
    workflowGroups: [],
    loadingWorkflows: false,
    selectedWorkflow: null,
    workflowContent: '',
    workflowDraft: null,
    workflowBuilderMode: 'builder',
    workflowBuilderStepIndex: 0,
    workflowBuilderError: '',
    workflowDrag: { source: null, type: null, index: null, overIndex: null },
    workflowSaving: false,
    workflowSaved: false,
    workflowError: '',
    showNewWorkflow: false,
    newWorkflowName: '',
    newWorkflowScope: null,
    newWorkflowTemplate: 'builder-reviewer',
    showWorkflowRun: false,
    workflowRunForm: {
      name: '',
      scope: null,
      channelKey: '',
      channelPlatform: '',
      channelId: '',
      model: '',
      inputText: '',
      files: '',
      toolset: '',
      threadId: '',
      preview: false,
    },
    workflowRunError: '',
    workflowRunSubmitting: false,

    // ---- Skills ----
    skillGroups: [],
    loadingSkills: false,
    selectedSkill: null,
    skillContent: '',
    skillFiles: [],
    selectedSkillFile: 'SKILL.md',
    skillFilePath: '',
    skillSaving: false,
    skillSaved: false,
    skillError: '',
    showNewSkill: false,
    newSkillName: '',
    newSkillScope: 'global',

    // ---- Personas ----
    personaGroups: [],
    loadingPersonas: false,
    selectedPersona: null,
    personaContent: '',
    personaSaving: false,
    personaSaved: false,
    personaError: '',
    showNewPersona: false,
    newPersonaName: '',
    newPersonaScope: null,

    // ---- Actions ----
    actionGroups: [],
    loadingActions: false,
    selectedAction: null,
    actionContent: '',
    actionSaving: false,
    actionSaved: false,
    actionError: '',
    showNewAction: false,
    newActionAgent: '',
    newActionAgents: [],
    newActionName: '',
    newActionScope: null,
    actionAssignedAgents: [],

    // ---- Projects ----
    projects: [],
    loadingProjects: false,
    showNewProject: false,
    channelDir: [],
    channelNames: {},
    channelDirError: '',

    // ---- Onboarding ----
    onboarding: { items: [], summary: {} },
    loadingOnboarding: false,
    guide: [],                 // step-by-step wizard content (from /onboarding/guide)
    activeGuideId: '',         // currently-open integration in the wizard
    verifyingId: '',           // id being re-checked by "Verify now"
    copiedKey: '',             // which code block was last copied (for the ✓ flash)
    prefText: '',
    prefScope: 'global',
    prefMsg: '',
    prefErr: false,
    newProjectName: '',
    newProjectError: '',

    // ---- Available Tools ----
    availableTools: null,
    loadingTools: false,
    toolsScope: '',
    _loadedToolsScope: null,

    // ---- Files ----
    ...AppModules.files.state(),

    // ---- Health ----
    ...AppModules.health.state(),

    // ---- Evals ----
    ...AppModules.evals.state(),

    // ---- Job detail ----
    ...AppModules.jobDetail.state(),

    // ---- Mobile two-pane state ----
    agentMobileDetailOpen: false,
    workflowMobileDetailOpen: false,
    skillMobileDetailOpen: false,
    personaMobileDetailOpen: false,
    actionMobileDetailOpen: false,
    logMobileDetailOpen: false,

    // ---- Toolsets ----
    toolsets: [],
    loadingToolsets: false,
    toolsetsSaving: false,
    toolsetsSaved: false,
    toolsetsError: '',
    toolsetPickerIdx: null,
    toolsetPickerQuery: '',

    // ---- Action editing ----
    showEditAction: false,
    editAction: { agentName: '', name: '', content: '', isNew: false },
    editActionSaving: false,
    editActionSaved: false,
    editActionError: '',

    // ---- Shared new-item error ----
    newItemError: '',

    async init() {
      this.applyTheme(this.theme);
      const hash = location.hash.replace('#', '') || 'overview';
      const validTabs = ['overview', 'onboarding', 'ask', 'activity', 'agents', 'actions', 'jobs', 'channels', 'approvals', 'efficiency', 'evals', 'logs', 'files', 'health', 'inbox', 'workflows', 'skills', 'personas', 'toolsets', 'projects', 'guide', 'tools'];
      this.tab = validTabs.includes(hash) ? hash : 'overview';

      window.addEventListener('hashchange', () => {
        const h = location.hash.replace('#', '');
        if (validTabs.includes(h)) {
          this.tab = h;
          this.onTabChange(h);
        }
      });

      await Promise.all([this.loadAgents(), this.loadJobs(), this.loadToolsets(), this.loadProjects()]);
      this.onTabChange(this.tab);
    },

    applyTheme(theme) {
      this.theme = theme === 'dark' ? 'dark' : 'light';
      document.documentElement.dataset.theme = this.theme;
      localStorage.setItem('agents-theme', this.theme);
    },

    toggleTheme() {
      this.applyTheme(this.theme === 'dark' ? 'light' : 'dark');
    },

    onTabChange(newTab) {
      if (newTab !== 'logs' && this.logEs) {
        this.logEs.close();
        this.logEs = null;
        this.logConnected = false;
      }
      if (newTab === 'overview') this.startOverviewRefresh();
      else this.stopOverviewRefresh();
      if (newTab === 'ask') this.initAskTab();
      if (newTab === 'activity') this.startActivityRefresh();
      else this.stopActivityRefresh();
      if (newTab === 'logs') this.loadAvailableLogs();
      if (newTab === 'files') this.loadFileRoots();
      if (newTab === 'health') this.loadHealth();
      if (newTab === 'inbox') this.startInboxRefresh();
      else this.stopInboxRefresh();
      if (newTab === 'jobs') this.startQueueRefresh();
      else { this.stopQueueRefresh(); this.stopJobDetailRefresh(); }
      if (newTab === 'channels') this.loadChannels();
      if (newTab === 'approvals') this.startApprovalsRefresh();
      else this.stopApprovalsRefresh();
      if (newTab === 'efficiency') { this.loadOverviewQueue(); this.loadAgentStats(); this.loadBudgets(); this.loadNotifications(); this.loadChannels(); }
      if (newTab === 'evals') this.loadEvals();
      if (newTab === 'workflows') { this.loadWorkflows(); this.ensureWorkflowBuilderCatalogs(); }
      if (newTab === 'skills') this.loadSkills();
      if (newTab === 'personas') this.loadPersonas();
      if (newTab === 'actions') { this.loadActions(); this.ensureWorkflowBuilderCatalogs(); }
      if (newTab === 'toolsets') this.loadToolsets();
      if (newTab === 'projects') this.loadProjects();
      if (newTab === 'onboarding') this.loadOnboarding();
      if (newTab === 'tools') this.loadTools();
    },

    navigate(section) {
      location.hash = section;
      this.tab = section;
      // Reset mobile detail state on tab switch
      this.agentMobileDetailOpen = false;
      this.workflowMobileDetailOpen = false;
      this.skillMobileDetailOpen = false;
      this.personaMobileDetailOpen = false;
      this.actionMobileDetailOpen = false;
      this.logMobileDetailOpen = false;
      this.onTabChange(section);
    },

    notify(message, type = 'info') {
      const id = Date.now() + Math.random();
      this.toasts.push({ id, message, type });
      setTimeout(() => {
        this.toasts = this.toasts.filter(toast => toast.id !== id);
      }, 3200);
    },

    markApiOk() {
      this.apiOffline = false;
      this.apiErrorMessage = '';
    },

    reportApiError(context, err) {
      const message = err && err.message ? err.message : String(err || 'Unknown error');
      this.apiOffline = true;
      this.apiErrorMessage = `${context}: ${message}`;
      this.notify(this.apiErrorMessage, 'error');
    },

    async apiJson(url, options = {}, context = 'Request failed') {
      try {
        const response = await fetch(url, options);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
        this.markApiOk();
        return data;
      } catch (err) {
        this.reportApiError(context, err);
        throw err;
      }
    },

    // ==================== OVERVIEW ====================

    ...AppModules.overview.methods,

    // ==================== ACTIVITY ====================

    startActivityRefresh() {
      this.loadActivity();
      this.stopActivityRefresh();
      this.activityTimer = setInterval(() => this.loadActivity(), 30000);
    },

    stopActivityRefresh() {
      if (this.activityTimer) { clearInterval(this.activityTimer); this.activityTimer = null; }
    },

    async loadActivity() {
      this.activityLoading = true;
      try {
        const r = await fetch('api/activity?limit=50');
        const data = await r.json();
        this.activity = data.map(e => ({ ...e, _expanded: false }));
        this.markApiOk();
      } catch (err) {
        console.error('activity load failed', err);
        this.reportApiError('Activity load failed', err);
      } finally {
        this.activityLoading = false;
      }
    },

    // ==================== AGENTS ====================

    ...AppModules.agents.methods,

    // ==================== JOBS ====================

    ...AppModules.jobs.methods,

    // ==================== APPROVALS ====================

    ...AppModules.approvals.methods,

    // ==================== CHANNELS ====================

    ...AppModules.channels.methods,

    // ==================== LOGS ====================

    ...AppModules.logs.methods,

    // ==================== FILES ====================

    ...AppModules.files.methods,

    // ==================== HEALTH ====================

    ...AppModules.health.methods,

    // ==================== EVALS ====================

    ...AppModules.evals.methods,

    // ==================== JOB DETAIL ====================

    ...AppModules.jobDetail.methods,

    // ==================== INBOX ====================

    startInboxRefresh() {
      this.loadInbox();
      this.stopInboxRefresh();
      this.inboxTimer = setInterval(() => this.loadInbox(), 60000);
    },

    stopInboxRefresh() {
      if (this.inboxTimer) { clearInterval(this.inboxTimer); this.inboxTimer = null; }
    },

    async loadInbox() {
      this.inboxLoading = true;
      try {
        const r = await fetch('api/inbox');
        const data = await r.json();
        this.markApiOk();
        this.inboxFiles = data.map(f => ({ ...f, _processing: false, _feedback: '', _feedbackOk: true }));
      } catch (err) {
        console.error('inbox load failed', err);
        this.reportApiError('Inbox load failed', err);
      } finally {
        this.inboxLoading = false;
      }
    },

    async processInboxFile(file) {
      file._processing = true;
      file._feedback = '';
      try {
        const r = await fetch('api/inbox/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: file.path }),
        });
        const data = await r.json();
        file._feedbackOk = r.ok;
        file._feedback = r.ok ? 'Dispatched' : (data.error || 'Error');
      } catch (err) {
        file._feedbackOk = false;
        file._feedback = 'Error';
        this.notify('Inbox process failed', 'error');
      } finally {
        file._processing = false;
      }
    },

    async processAllInbox() {
      this.inboxProcessingAll = true;
      try {
        const r = await fetch('api/inbox/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = await r.json();
        // Reload inbox after processing
        await this.loadInbox();
        this.notify(data.processed ? `Processed ${data.processed} inbox file${data.processed === 1 ? '' : 's'}` : 'Inbox processing started');
      } catch (err) {
        console.error('process all failed', err);
        this.reportApiError('Inbox process failed', err);
      } finally {
        this.inboxProcessingAll = false;
      }
    },

    // ==================== RUN MODAL ====================

    ...AppModules.runModal.methods,

    // ==================== ASK AGENT ====================

    ...AppModules.ask.methods,

    // ==================== WORKFLOWS ====================

    async loadWorkflows() {
      this.loadingWorkflows = true;
      try {
        const r = await fetch('api/workflows');
        this.workflowGroups = await r.json();
        this.markApiOk();
      } catch (err) { console.error('workflows load failed', err); this.reportApiError('Workflows load failed', err); }
      finally { this.loadingWorkflows = false; }
    },

    async selectWorkflow(wf) {
      this.selectedWorkflow = wf;
      this.workflowMobileDetailOpen = true;
      this.workflowContent = '';
      this.workflowError = '';
      this.workflowSaved = false;
      this.workflowDraft = { name: wf.name, outputChannel: { platform: '', id: '' }, steps: [], body: '' };
      const sp = this.scopeParam(wf.scope);
      try {
        const r = await fetch(`api/workflows/${encodeURIComponent(wf.name)}${sp}`);
        const data = await r.json();
        this.workflowContent = data.content || '';
        this.syncWorkflowContentToDraft();
        this.ensureWorkflowBuilderCatalogs();
      } catch (err) { this.workflowError = err.message; this.notify('Workflow load failed', 'error'); }
    },

    async saveWorkflow() {
      this.workflowSaving = true; this.workflowError = ''; this.workflowSaved = false;
      if (this.workflowBuilderMode === 'builder') this.syncWorkflowDraftToContent();
      const sp = this.scopeParam(this.selectedWorkflow.scope);
      try {
        const r = await fetch(`api/workflows/${encodeURIComponent(this.selectedWorkflow.name)}${sp}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: this.workflowContent }),
        });
        if (!r.ok) { this.workflowError = (await r.json()).error; return; }
        this.workflowSaved = true;
        this.notify('Workflow saved');
        setTimeout(() => { this.workflowSaved = false; }, 3000);
      } catch (err) { this.workflowError = err.message; this.notify('Workflow save failed', 'error'); }
      finally { this.workflowSaving = false; }
    },

    async runWorkflowNow(name) {
      try {
        const r = await fetch(`api/workflows/${encodeURIComponent(name)}/run`, { method: 'POST' });
        const data = await r.json();
        if (data.jobId) this.watchJob(data.jobId, 'workflow', name);
      } catch (err) { this.reportApiError('Workflow run failed', err); }
    },

    openNewWorkflowModal() {
      this.showNewWorkflow = true;
      this.newWorkflowName = '';
      this.newWorkflowScope = null;
      this.newWorkflowTemplate = 'builder-reviewer';
      this.newItemError = '';
    },

    async openWorkflowRunModal(workflow = this.selectedWorkflow) {
      if (!workflow) return;
      this.workflowRunForm = {
        name: workflow.name,
        scope: workflow.scope || null,
        channelKey: '',
        channelPlatform: '',
        channelId: '',
        model: '',
        inputText: '',
        files: '',
        toolset: '',
        threadId: '',
        preview: false,
      };
      this.workflowRunError = '';
      this.workflowRunSubmitting = false;
      this.showWorkflowRun = true;
      if (!this.channels.length && !this.channelsLoading) {
        try { await this.loadChannels(); } catch {}
      }
      if (!this.toolsets.length && !this.loadingToolsets) {
        try { await this.loadToolsets(); } catch {}
      }
    },

    closeWorkflowRunModal() {
      if (this.workflowRunSubmitting) return;
      this.showWorkflowRun = false;
      this.workflowRunError = '';
    },

    workflowRunChannelOptions() {
      return (this.channels || []).map(mapping => ({
        key: `${mapping.platform}:${mapping.channelId}`,
        label: `${mapping.platform} / ${mapping.channelId}${mapping.agent ? ` (${mapping.agent})` : ''}`,
        platform: mapping.platform,
        id: mapping.channelId,
      }));
    },

    channelSelectionOptions() {
      return this.workflowRunChannelOptions();
    },

    channelPlatformOptions() {
      const platforms = new Set(['slack', 'discord']);
      for (const mapping of this.channels || []) {
        if (mapping.platform) platforms.add(mapping.platform);
      }
      return Array.from(platforms).sort((a, b) => a.localeCompare(b));
    },

    channelSelectionKey(channel = {}) {
      if (!channel?.platform || !channel?.id) return '';
      const key = `${channel.platform}:${channel.id}`;
      return this.channelSelectionOptions().some(option => option.key === key) ? key : 'custom';
    },

    channelIsCustom(channel = {}) {
      return this.channelSelectionKey(channel) === 'custom';
    },

    onChannelObjectChange(channel, value, afterChange = null) {
      if (!channel) return;
      const option = this.channelSelectionOptions().find(item => item.key === value);
      if (option) {
        channel.platform = option.platform;
        channel.id = option.id;
      } else if (!value) {
        channel.platform = '';
        channel.id = '';
      } else if (value === 'custom') {
        channel.platform = channel.platform || 'slack';
        channel.id = '';
      }
      if (afterChange) afterChange();
    },

    onWorkflowRunChannelChange(value) {
      this.workflowRunForm.channelKey = value;
      const option = this.workflowRunChannelOptions().find(item => item.key === value);
      if (option) {
        this.workflowRunForm.channelPlatform = option.platform;
        this.workflowRunForm.channelId = option.id;
        return;
      }
      if (!value || value === 'custom') {
        this.workflowRunForm.channelPlatform = '';
        this.workflowRunForm.channelId = '';
      }
    },

    workflowRunScopeOptions() {
      const options = [{ value: null, label: 'Global (vault)' }];
      for (const project of this.projects || []) options.push({ value: project.name, label: `${project.name} (project)` });
      const selected = this.selectedWorkflow?.scope;
      if (selected && !options.some(option => option.value === selected)) {
        options.push({ value: selected, label: `${selected} (project)` });
      }
      return options;
    },

    workflowRunPayload() {
      const form = this.workflowRunForm;
      const outputChannel = form.channelPlatform && form.channelId
        ? { platform: form.channelPlatform, id: form.channelId }
        : undefined;
      const files = form.files.trim()
        ? form.files.split(',').map(item => item.trim()).filter(Boolean)
        : undefined;
      return {
        scope: form.scope || undefined,
        model: form.model || undefined,
        toolset: form.toolset || undefined,
        outputChannel,
        threadId: form.threadId.trim() || undefined,
        files,
        replyText: form.inputText.trim() || undefined,
        workflowContext: form.inputText.trim() || undefined,
        mode: form.preview ? 'preview' : 'async',
      };
    },

    async submitWorkflowRun() {
      if (!this.workflowRunForm.name || this.workflowRunSubmitting) return;
      this.workflowRunError = '';
      this.workflowRunSubmitting = true;
      try {
        const r = await fetch(`api/workflows/${encodeURIComponent(this.workflowRunForm.name)}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.workflowRunPayload()),
        });
        const data = await r.json();
        if (!r.ok) {
          this.workflowRunError = data.error || 'Workflow run failed';
          return;
        }
        this.showWorkflowRun = false;
        if (data.jobId) this.watchJob(data.jobId, 'workflow', this.workflowRunForm.name);
        else this.notify('Workflow run submitted');
      } catch (err) {
        this.workflowRunError = err.message;
        this.reportApiError('Workflow run failed', err);
      } finally {
        this.workflowRunSubmitting = false;
      }
    },

    workflowYamlBlock() {
      const match = this.workflowContent.match(/^---\n([\s\S]*?)\n---/);
      return match ? match[1] : this.workflowContent;
    },

    parseWorkflowContent(content) {
      const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      const yaml = match ? match[1] : '';
      const body = match ? match[2] : '';
      const draft = { name: this.selectedWorkflow?.name || '', outputChannel: { platform: '', id: '' }, steps: [], body };
      let currentStep = null;
      let nested = null;
      for (const raw of yaml.split('\n')) {
        if (!raw.trim() || raw.trim() === 'steps:') continue;
        const indent = raw.match(/^\s*/)[0].length;
        const line = raw.trim();
        const stepStart = line.match(/^-\s+type:\s*(.*)$/);
        if (stepStart) {
          currentStep = { type: this.unquoteYaml(stepStart[1]) || 'agent', outputChannel: { platform: '', id: '' } };
          draft.steps.push(currentStep);
          nested = null;
          continue;
        }
        const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!pair) continue;
        const key = pair[1];
        const value = this.unquoteYaml(pair[2] || '');
        if (currentStep && indent >= 4) {
          if (key === 'outputChannel') { nested = 'stepOutputChannel'; continue; }
          if (nested === 'stepOutputChannel' && (key === 'platform' || key === 'id')) {
            currentStep.outputChannel[key] = value;
          } else {
            currentStep[key] = value;
            nested = null;
          }
          continue;
        }
        if (key === 'outputChannel') { nested = 'workflowOutputChannel'; continue; }
        if (nested === 'workflowOutputChannel' && (key === 'platform' || key === 'id')) {
          draft.outputChannel[key] = value;
        } else if (key === 'name') {
          draft.name = value;
          nested = null;
        }
      }
      return draft;
    },

    syncWorkflowContentToDraft() {
      try {
        this.workflowDraft = this.parseWorkflowContent(this.workflowContent);
        this.workflowBuilderStepIndex = 0;
        this.workflowBuilderError = '';
      } catch (err) {
        this.workflowBuilderError = err.message;
      }
    },

    syncWorkflowDraftToContent() {
      if (!this.workflowDraft) return;
      this.workflowContent = this.serializeWorkflowDraft(this.workflowDraft);
    },

    serializeWorkflowDraft(draft) {
      const lines = ['---', `name: ${this.yamlValue(draft.name || this.selectedWorkflow?.name || 'Workflow')}`, 'steps:'];
      for (const step of draft.steps || []) {
        lines.push(`  - type: ${this.yamlValue(step.type || 'agent')}`);
        for (const key of this.workflowStepFieldOrder(step.type)) {
          if (step[key] !== undefined && step[key] !== '') lines.push(`    ${key}: ${this.yamlValue(step[key])}`);
        }
        if (step.outputChannel?.platform || step.outputChannel?.id) {
          lines.push('    outputChannel:');
          if (step.outputChannel.platform) lines.push(`      platform: ${this.yamlValue(step.outputChannel.platform)}`);
          if (step.outputChannel.id) lines.push(`      id: ${this.yamlValue(step.outputChannel.id)}`);
        }
      }
      if (draft.outputChannel?.platform || draft.outputChannel?.id) {
        lines.push('outputChannel:');
        if (draft.outputChannel.platform) lines.push(`  platform: ${this.yamlValue(draft.outputChannel.platform)}`);
        if (draft.outputChannel.id) lines.push(`  id: ${this.yamlValue(draft.outputChannel.id)}`);
      }
      lines.push('---', '', draft.body || '');
      return lines.join('\n');
    },

    yamlValue(value) {
      const text = String(value ?? '');
      if (!text) return '""';
      if (/^[A-Za-z0-9_.\/:-]+$/.test(text)) return text;
      return JSON.stringify(text);
    },

    unquoteYaml(value) {
      const text = String(value ?? '').trim();
      if (!text) return '';
      if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        try { return JSON.parse(text); } catch { return text.slice(1, -1); }
      }
      return text;
    },

    workflowStepFieldOrder(type) {
      const adaptive = ['runIf', 'runIfText', 'onFailure', 'maxAttempts', 'maxVisits', 'successWhen', 'successText', 'jumpOnSuccess', 'jumpOnFailure'];
      const shared = ['toolset', 'model', ...adaptive];
      if (type === 'agent') return ['agent', 'action', ...shared];
      if (type === 'skill') return ['agent', 'agentScope', 'skill', 'args', ...shared];
      if (type === 'workflow') return ['workflow', ...shared];
      if (type === 'approval') return ['prompt', 'timeoutMinutes', 'onDeny', 'onTimeout'];
      return shared;
    },

    async ensureWorkflowBuilderCatalogs() {
      const loads = [];
      if (!this.agentGroups.length && !this.loadingAgents) loads.push(this.loadAgents());
      if (!this.actionGroups.length && !this.loadingActions) loads.push(this.loadActions());
      if (!this.skillGroups.length && !this.loadingSkills) loads.push(this.loadSkills());
      if (!this.toolsets.length && !this.loadingToolsets) loads.push(this.loadToolsets());
      if (!this.channels.length && !this.channelsLoading) loads.push(this.loadChannels());
      if (loads.length) {
        try { await Promise.all(loads); } catch {}
      }
    },

    normalizeWorkflowScope(scope) {
      const value = String(scope ?? '').trim();
      const lower = value.toLowerCase();
      return !value || lower === 'null' || lower === 'global' ? null : value;
    },

    workflowScope() {
      return this.normalizeWorkflowScope(this.selectedWorkflow?.scope);
    },

    workflowOptionLabel(name, scope) {
      if (!scope || scope === 'global') return name;
      return `${name} (${scope})`;
    },

    workflowIncludeCurrentOption(options, current, scope = null) {
      const value = String(current || '').trim();
      if (!value) return options;
      const exact = options.find(option => option.name === value);
      if (exact) return options;
      const caseMatch = options.find(option => option.name.toLowerCase() === value.toLowerCase());
      if (caseMatch) {
        return [{ ...caseMatch, name: value }, ...options.filter(option => option !== caseMatch)];
      }
      return [{ name: value, label: `${value} (not found)`, scope }, ...options];
    },

    workflowAgentOptions(current = '') {
      const scope = this.workflowScope();
      const scopes = scope ? [scope, null] : [null];
      const seen = new Set();
      const options = [];
      for (const agent of this.agents || []) {
        const agentScope = this.normalizeWorkflowScope(agent.scope);
        const key = `${agentScope || 'global'}:${agent.name.toLowerCase()}`;
        if (!scopes.includes(agentScope) || seen.has(key)) continue;
        seen.add(key);
        options.push({ name: agent.name, label: this.workflowOptionLabel(agent.name, agentScope), scope: agentScope });
      }
      options.sort((a, b) => a.label.localeCompare(b.label));
      return this.workflowIncludeCurrentOption(options, current, scope);
    },

    workflowActionOptions(step = {}) {
      const scope = this.workflowScope();
      const agentName = step.agent || '';
      if (!agentName) return this.workflowIncludeCurrentOption([], step.action, scope);
      const scopes = scope ? [scope, null] : [null];
      const seen = new Set();
      const options = [];
      for (const wantedScope of scopes) {
        const group = (this.actionGroups || []).find(item => this.normalizeWorkflowScope(item.scope) === wantedScope);
        const agent = group?.agents?.find(item => item.name.toLowerCase() === agentName.toLowerCase());
        for (const action of agent?.actions || []) {
          if (seen.has(action.name.toLowerCase())) continue;
          seen.add(action.name.toLowerCase());
          options.push({ name: action.name, label: this.workflowOptionLabel(action.name, wantedScope), scope: wantedScope });
        }
      }
      options.sort((a, b) => a.label.localeCompare(b.label));
      return this.workflowIncludeCurrentOption(options, step.action, scope);
    },

    workflowSkillAgentValue(step = {}) {
      if (!step.agent) return '';
      return `${this.normalizeWorkflowScope(step.agentScope) || 'global'}::${step.agent}`;
    },

    onWorkflowSkillAgentChange(step, value) {
      const [rawScope, ...agentParts] = String(value || '').split('::');
      step.agent = agentParts.join('::') || '';
      step.agentScope = step.agent ? (rawScope === 'global' ? '' : rawScope) : '';
      step.skill = '';
      this.syncWorkflowDraftToContent();
    },

    workflowAgentScopeKey(scope, agent, agentScope = undefined) {
      const safeScope = (agentScope === undefined ? this.normalizeWorkflowScope(scope) : this.normalizeWorkflowScope(agentScope)) || 'global';
      const safeAgent = String(agent || '').trim();
      return safeAgent ? `agent:${safeScope}:${safeAgent}` : null;
    },

    workflowSkillOptions(step = {}) {
      const scope = this.workflowScope();
      const current = step.skill || '';
      const scopes = [];
      const agentScope = this.workflowAgentScopeKey(scope, step.agent, step.agentScope);
      if (agentScope) scopes.push(agentScope);
      if (scope) scopes.push(scope);
      scopes.push('global');
      const seen = new Set();
      const options = [];
      for (const wantedScope of scopes) {
        const group = (this.skillGroups || []).find(item => item.scope === wantedScope);
        for (const skill of group?.skills || []) {
          if (seen.has(skill.name)) continue;
          seen.add(skill.name);
          options.push({ name: skill.name, label: this.workflowOptionLabel(skill.name, wantedScope), scope: wantedScope });
        }
      }
      options.sort((a, b) => a.label.localeCompare(b.label));
      return this.workflowIncludeCurrentOption(options, current, scope || 'global');
    },

    workflowNestedWorkflowOptions(current = '') {
      const scope = this.workflowScope();
      const scopes = scope ? [scope, null] : [null];
      const currentWorkflowName = this.selectedWorkflow?.name || '';
      const seen = new Set();
      const options = [];
      for (const wantedScope of scopes) {
        const group = (this.workflowGroups || []).find(item => (item.scope || null) === wantedScope);
        for (const workflow of group?.workflows || []) {
          if (workflow.name === currentWorkflowName && (workflow.scope || null) === scope) continue;
          if (seen.has(workflow.name)) continue;
          seen.add(workflow.name);
          options.push({ name: workflow.name, label: this.workflowOptionLabel(workflow.name, workflow.scope || null), scope: workflow.scope || null });
        }
      }
      options.sort((a, b) => a.label.localeCompare(b.label));
      return this.workflowIncludeCurrentOption(options, current, scope);
    },

    workflowToolsetOptions(current = '') {
      const options = (this.toolsets || [])
        .map(toolset => ({ name: toolset.name, label: toolset.name }))
        .sort((a, b) => a.label.localeCompare(b.label));
      return this.workflowIncludeCurrentOption(options, current);
    },

    onWorkflowStepAgentChange(step) {
      if (!step) return;
      step.action = '';
      this.syncWorkflowDraftToContent();
    },

    workflowSteps() {
      const lines = this.workflowYamlBlock().split('\n');
      const steps = [];
      let current = null;
      for (const rawLine of lines) {
        const line = rawLine.trim();
        const start = line.match(/^-\s+type:\s*(.+)$/);
        if (start) {
          current = { index: steps.length + 1, type: start[1].trim() };
          steps.push(current);
          continue;
        }
        if (!current) continue;
        const field = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
        if (field) current[field[1]] = field[2].replace(/^["']|["']$/g, '').trim();
      }
      return steps;
    },

    workflowValidation() {
      const steps = this.workflowSteps();
      const warnings = [];
      if (steps.length === 0) warnings.push('No workflow steps found.');
      for (const step of steps) {
        if (!['agent', 'skill', 'workflow', 'approval'].includes(step.type)) warnings.push(`Step ${step.index}: unknown type "${step.type || 'missing'}".`);
        if (step.type === 'agent' && !step.agent) warnings.push(`Step ${step.index}: agent step is missing agent.`);
        if (step.type === 'agent' && !step.action) warnings.push(`Step ${step.index}: agent step is missing action.`);
        if (step.type === 'skill' && !step.skill) warnings.push(`Step ${step.index}: skill step is missing skill.`);
        if (step.type === 'workflow' && !step.workflow) warnings.push(`Step ${step.index}: workflow step is missing workflow.`);
        if (step.type === 'approval' && !step.prompt) warnings.push(`Step ${step.index}: approval step is missing prompt.`);
        if (['output_includes', 'output_excludes'].includes(step.successWhen) && !step.successText) warnings.push(`Step ${step.index}: successText is required for ${step.successWhen}.`);
        if (['previous_output_includes', 'previous_output_excludes'].includes(step.runIf) && !step.runIfText) warnings.push(`Step ${step.index}: runIfText is required for ${step.runIf}.`);
        for (const field of ['jumpOnSuccess', 'jumpOnFailure']) {
          if (step[field] && (!Number.isInteger(Number(step[field])) || Number(step[field]) < 1 || Number(step[field]) > steps.length)) warnings.push(`Step ${step.index}: ${field} must be a valid step number.`);
        }
      }
      return warnings;
    },

    workflowSummary() {
      const steps = this.workflowSteps();
      const agents = steps.filter(s => s.type === 'agent').length;
      const skills = steps.filter(s => s.type === 'skill').length;
      const nested = steps.filter(s => s.type === 'workflow').length;
      const approvals = steps.filter(s => s.type === 'approval').length;
      return `${steps.length} step${steps.length === 1 ? '' : 's'} · ${agents} agent · ${skills} skill · ${nested} nested · ${approvals} approval`;
    },

    workflowStepClass(type) {
      return {
        agent: 'bg-indigo-900 text-indigo-300',
        skill: 'bg-green-900 text-green-300',
        workflow: 'bg-purple-900 text-purple-300',
        approval: 'bg-yellow-900 text-yellow-300',
      }[type] || 'bg-yellow-900 text-yellow-300';
    },

    workflowStepAccentClass(type) {
      return {
        agent: 'workflow-node--agent',
        skill: 'workflow-node--skill',
        workflow: 'workflow-node--workflow',
        approval: 'workflow-node--approval',
      }[type] || 'workflow-node--unknown';
    },

    workflowPaletteItems() {
      return [
        { type: 'agent', label: 'Agent', detail: 'Run an agent action' },
        { type: 'skill', label: 'Skill', detail: 'Load a skill prompt' },
        { type: 'workflow', label: 'Workflow', detail: 'Nest another workflow' },
        { type: 'approval', label: 'Approval', detail: 'Pause for review' },
      ];
    },

    workflowStepTitle(step) {
      if (step.type === 'agent') return `${step.agent || 'Missing agent'} / ${step.action || 'Missing action'}`;
      if (step.type === 'skill') return step.skill || 'Missing skill';
      if (step.type === 'workflow') return step.workflow || 'Missing workflow';
      if (step.type === 'approval') return step.prompt || 'Missing prompt';
      return 'Unknown step';
    },

    workflowStepSubtitle(step) {
      const parts = [];
      if (step.toolset) parts.push(`toolset: ${step.toolset}`);
      if (step.mode) parts.push(`mode: ${step.mode}`);
      if (step.scope) parts.push(`scope: ${step.scope}`);
      if (step.model) parts.push(`model: ${step.model}`);
      if (step.timeoutMinutes) parts.push(`timeout: ${step.timeoutMinutes}m`);
      if (step.maxAttempts) parts.push(`attempts: ${step.maxAttempts}`);
      if (step.maxVisits) parts.push(`visits: ${step.maxVisits}`);
      if (step.runIf && step.runIf !== 'always') parts.push(`if: ${step.runIf}`);
      if (step.successWhen && step.successWhen !== 'job_ok') parts.push(`success: ${step.successWhen}`);
      if (step.jumpOnFailure) parts.push(`fail -> ${step.jumpOnFailure}`);
      if (step.jumpOnSuccess) parts.push(`ok -> ${step.jumpOnSuccess}`);
      return parts.join(' · ') || '-';
    },

    selectedWorkflowBuilderStep() {
      return this.workflowDraft?.steps?.[this.workflowBuilderStepIndex] || null;
    },

    workflowBuilderSteps() {
      return (this.workflowDraft?.steps || []).map((step, index) => ({ ...step, index: index + 1 }));
    },

    selectWorkflowBuilderStep(index) {
      this.workflowBuilderStepIndex = index;
    },

    createWorkflowStep(type = 'agent') {
      const step = { type, outputChannel: { platform: '', id: '' } };
      const adaptive = { runIf: 'always', onFailure: 'abort', maxAttempts: '', maxVisits: '', successWhen: 'job_ok', successText: '', runIfText: '', jumpOnSuccess: '', jumpOnFailure: '' };
      if (type === 'agent') Object.assign(step, { agent: '', action: '', toolset: 'default' }, adaptive);
      if (type === 'skill') Object.assign(step, { agent: '', agentScope: '', skill: '', args: '', toolset: 'default' }, adaptive);
      if (type === 'workflow') Object.assign(step, { workflow: '', toolset: 'default' }, adaptive);
      if (type === 'approval') Object.assign(step, { prompt: '', timeoutMinutes: '60', onDeny: 'abort', onTimeout: 'abort' });
      return step;
    },

    addWorkflowStep(type = 'agent', index = null) {
      if (!this.workflowDraft) this.workflowDraft = { name: this.selectedWorkflow?.name || '', outputChannel: { platform: '', id: '' }, steps: [], body: '' };
      const step = this.createWorkflowStep(type);
      const insertAt = index === null ? this.workflowDraft.steps.length : Math.max(0, Math.min(index, this.workflowDraft.steps.length));
      this.workflowDraft.steps.splice(insertAt, 0, step);
      this.workflowBuilderStepIndex = insertAt;
      this.syncWorkflowDraftToContent();
    },

    beginWorkflowPaletteDrag(type, event) {
      this.workflowDrag = { source: 'palette', type, index: null, overIndex: this.workflowDraft?.steps?.length || 0 };
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('text/plain', `palette:${type}`);
    },

    beginWorkflowStepDrag(index, event) {
      this.workflowDrag = { source: 'step', type: null, index, overIndex: index };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', `step:${index}`);
    },

    workflowDragOver(index) {
      if (!this.workflowDrag.source) return;
      this.workflowDrag.overIndex = index;
    },

    workflowDropAt(index) {
      const drag = this.workflowDrag;
      if (!drag.source) return;
      if (!this.workflowDraft) this.workflowDraft = { name: this.selectedWorkflow?.name || '', outputChannel: { platform: '', id: '' }, steps: [], body: '' };
      const target = Math.max(0, Math.min(index, this.workflowDraft.steps.length));
      if (drag.source === 'palette' && drag.type) {
        this.addWorkflowStep(drag.type, target);
      } else if (drag.source === 'step' && drag.index !== null) {
        this.moveWorkflowStepTo(drag.index, target);
      }
      this.endWorkflowDrag();
    },

    workflowDropOnCanvas() {
      this.workflowDropAt(this.workflowDraft?.steps?.length || 0);
    },

    moveWorkflowStepTo(index, targetIndex) {
      const steps = this.workflowDraft?.steps;
      if (!steps || index < 0 || index >= steps.length) return;
      let target = Math.max(0, Math.min(targetIndex, steps.length));
      if (target > index) target -= 1;
      if (target === index) {
        this.workflowBuilderStepIndex = index;
        return;
      }
      const [step] = steps.splice(index, 1);
      steps.splice(target, 0, step);
      this.workflowBuilderStepIndex = target;
      this.syncWorkflowDraftToContent();
    },

    endWorkflowDrag() {
      this.workflowDrag = { source: null, type: null, index: null, overIndex: null };
    },

    removeWorkflowStep(index) {
      if (!this.workflowDraft?.steps) return;
      this.workflowDraft.steps.splice(index, 1);
      this.workflowBuilderStepIndex = Math.max(0, Math.min(this.workflowBuilderStepIndex, this.workflowDraft.steps.length - 1));
      this.syncWorkflowDraftToContent();
    },

    moveWorkflowStep(index, dir) {
      const steps = this.workflowDraft?.steps;
      if (!steps) return;
      const target = index + dir;
      if (target < 0 || target >= steps.length) return;
      const [step] = steps.splice(index, 1);
      steps.splice(target, 0, step);
      this.workflowBuilderStepIndex = target;
      this.syncWorkflowDraftToContent();
    },

    setWorkflowStepType(step, type) {
      for (const key of Object.keys(step)) {
        if (!['outputChannel'].includes(key)) delete step[key];
      }
      step.type = type;
      step.outputChannel = step.outputChannel || { platform: '', id: '' };
      const adaptive = { runIf: 'always', onFailure: 'abort', maxAttempts: '', maxVisits: '', successWhen: 'job_ok', successText: '', runIfText: '', jumpOnSuccess: '', jumpOnFailure: '' };
      if (type === 'agent') Object.assign(step, { agent: '', action: '', toolset: 'default' }, adaptive);
      if (type === 'skill') Object.assign(step, { agent: '', agentScope: '', skill: '', args: '', toolset: 'default' }, adaptive);
      if (type === 'workflow') Object.assign(step, { workflow: '', toolset: 'default' }, adaptive);
      if (type === 'approval') Object.assign(step, { prompt: '', timeoutMinutes: '60', onDeny: 'abort', onTimeout: 'abort' });
      this.syncWorkflowDraftToContent();
    },

    runWorkflowStep(step) {
      if (step.type === 'agent' && step.agent && step.action) {
        this.openRunModal(step.agent, step.action, step.scope || this.selectedWorkflow?.scope || null);
      }
    },

    workflowTemplates() {
      return [
        { id: 'blank', name: 'Blank', detail: 'Single starter step' },
        { id: 'builder-reviewer', name: 'Builder -> Reviewer Loop', detail: 'Draft, review, jump back until APPROVED' },
        { id: 'code-test-fix', name: 'Code -> Test -> Fix', detail: 'Implement, test, fix on failure, summarize' },
        { id: 'research-publish', name: 'Research -> Approval -> Publish', detail: 'Draft brief, pause for review, publish' },
        { id: 'triage-route', name: 'Triage -> Route', detail: 'Classify input and run a matching follow-up' },
        { id: 'evaluator-gate', name: 'Evaluator Gate', detail: 'Run work through a scoring/evaluation pass' },
      ];
    },

    selectedWorkflowTemplate() {
      return this.workflowTemplates().find(t => t.id === this.newWorkflowTemplate) || this.workflowTemplates()[0];
    },

    workflowTemplateContent(name, templateId = this.newWorkflowTemplate) {
      const title = name || 'Workflow';
      const escaped = this.yamlValue(title);
      const templates = {
        blank: `---
name: ${escaped}
steps:
  - type: agent
    agent: AgentName
    action: Action Name
    toolset: default
---

# ${title}

Description of what this workflow does.
`,
        'builder-reviewer': `---
name: ${escaped}
steps:
  - type: agent
    agent: Builder
    action: Draft Change
    toolset: code
    maxVisits: 3
  - type: agent
    agent: Reviewer
    action: Review Change
    successWhen: output_includes
    successText: APPROVED
    jumpOnFailure: 1
    maxVisits: 3
---

# ${title}

Builder creates the work. Reviewer must include APPROVED or the workflow jumps back to Builder with the review output as context.

## Marker Contract

- Reviewer must end with APPROVED when the change is acceptable.
- Reviewer should use NEEDS_CHANGES when more work is required, followed by specific feedback for Builder.
- Reviewer should use BLOCKED when it cannot evaluate the change.
`,
        'code-test-fix': `---
name: ${escaped}
steps:
  - type: agent
    agent: Coder
    action: Implement Change
    toolset: code
    maxVisits: 3
  - type: agent
    agent: Tester
    action: Run Verification
    toolset: code
    successWhen: output_includes
    successText: TESTS_PASS
    jumpOnFailure: 1
    maxVisits: 3
  - type: agent
    agent: Summarizer
    action: Summarize Result
    toolset: default
---

# ${title}

Coder implements, Tester reports TESTS_PASS when verification is clean, and Summarizer writes the final outcome.

## Marker Contract

- Tester must include TESTS_PASS when verification is clean.
- Tester should use TESTS_FAIL when checks fail, followed by the failing command/output and the smallest useful fix hint.
- Tester should use BLOCKED when verification cannot run.
`,
        'research-publish': `---
name: ${escaped}
steps:
  - type: agent
    agent: Researcher
    action: Draft Brief
    toolset: web
  - type: approval
    prompt: Approve publishing this brief?
    timeoutMinutes: 60
    onDeny: abort
    onTimeout: abort
  - type: agent
    agent: Publisher
    action: Publish Brief
    toolset: default
---

# ${title}

Researcher drafts, approval pauses for review, Publisher posts or records the approved brief.

## Marker Contract

- Researcher should include READY_FOR_APPROVAL when the draft is complete.
- Publisher should include PUBLISHED after posting or recording the approved brief.
- Any step should use BLOCKED when required source material or access is missing.
`,
        'triage-route': `---
name: ${escaped}
steps:
  - type: agent
    agent: Triage
    action: Classify Request
    toolset: default
  - type: agent
    agent: Coding
    action: Handle Coding Request
    toolset: code
    runIf: previous_output_includes
    runIfText: ROUTE:code
  - type: agent
    agent: Researcher
    action: Handle Research Request
    toolset: web
    runIf: previous_output_includes
    runIfText: ROUTE:research
---

# ${title}

Triage should emit route markers such as ROUTE:code or ROUTE:research. Matching downstream steps run only when their marker appears.

## Marker Contract

- Triage must include exactly one primary route marker: ROUTE:code or ROUTE:research.
- Triage may include BLOCKED if it cannot classify the request.
- Downstream route handlers should include HANDLED when their work is complete.
`,
        'evaluator-gate': `---
name: ${escaped}
steps:
  - type: agent
    agent: Worker
    action: Produce Candidate
    toolset: default
    maxVisits: 3
  - type: agent
    agent: Evaluator
    action: Score Candidate
    toolset: default
    successWhen: output_includes
    successText: PASS
    jumpOnFailure: 1
    maxVisits: 3
---

# ${title}

Evaluator must include PASS. Otherwise the candidate output is fed back to Worker for another visit.

## Marker Contract

- Evaluator must include PASS when the candidate meets the bar.
- Evaluator should use FAIL when the candidate needs another pass, followed by concrete feedback for Worker.
- Evaluator should use BLOCKED when it cannot evaluate the candidate.
`,
      };
      return templates[templateId] || templates.blank;
    },

    async submitNewWorkflow() {
      this.newItemError = '';
      if (!this.newWorkflowName.trim()) { this.newItemError = 'Name is required.'; return; }
      const name = this.newWorkflowName.trim();
      try {
        const r = await fetch('api/workflows', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            scope: this.normalizeWorkflowScope(this.newWorkflowScope),
            content: this.workflowTemplateContent(name),
          }),
        });
        if (!r.ok) { this.newItemError = (await r.json()).error; return; }
        this.showNewWorkflow = false;
        await this.loadWorkflows();
        const createdScope = this.normalizeWorkflowScope(this.newWorkflowScope);
        const group = this.workflowGroups.find(g => this.normalizeWorkflowScope(g.scope) === createdScope);
        const wf = group && group.workflows.find(w => w.name === name);
        if (wf) this.selectWorkflow(wf);
        this.notify('Workflow created');
      } catch (err) { this.newItemError = err.message; this.notify('Workflow creation failed', 'error'); }
    },

    async deleteWorkflow(name, scope) {
      const sp = this.scopeParam(scope);
      await fetch(`api/workflows/${encodeURIComponent(name)}${sp}`, { method: 'DELETE' });
      this.selectedWorkflow = null;
      this.workflowContent = '';
      await this.loadWorkflows();
      this.notify('Workflow deleted');
    },

    // ==================== SKILLS ====================

    async loadSkills() {
      this.loadingSkills = true;
      try {
        const r = await fetch('api/skills');
        this.skillGroups = await r.json();
        this.markApiOk();
      } catch (err) { console.error('skills load failed', err); this.reportApiError('Skills load failed', err); }
      finally { this.loadingSkills = false; }
    },

    skillScopeLabel(scope) {
      if (scope === 'global') return 'Global';
      if (String(scope || '').startsWith('agent:')) {
        const [, rawScope, ...agentParts] = String(scope).split(':');
        const agent = agentParts.join(':');
        return rawScope === 'global' ? `Global / ${agent}` : `${rawScope} / ${agent}`;
      }
      return scope;
    },

    skillPathLabel(skill = this.selectedSkill) {
      if (!skill) return '';
      const scope = skill.scope;
      if (scope === 'global') return `~/.claude/skills/${skill.name}`;
      if (String(scope || '').startsWith('agent:')) {
        const [, rawScope, ...agentParts] = String(scope).split(':');
        const agent = agentParts.join(':');
        return rawScope === 'global'
          ? `~/.claude/agents/${agent}/skills/${skill.name}`
          : `${rawScope}/.claude/agents/${agent}/skills/${skill.name}`;
      }
      return `${scope}/.claude/skills/${skill.name}`;
    },

    skillScopeOptions() {
      const options = [{ value: 'global', label: 'Global (~/.claude/skills/)' }];
      for (const project of this.projects || []) {
        options.push({ value: project.name, label: `${project.name} (workspace)` });
      }
      for (const agent of this.agents || []) {
        const scope = agent.scope || 'global';
        const value = `agent:${scope}:${agent.name}`;
        const label = agent.scope
          ? `${agent.scope} / ${agent.name} (agent)`
          : `${agent.name} (global agent)`;
        options.push({ value, label });
      }
      return options;
    },

    async selectSkill(sk, scope) {
      this.selectedSkill = { ...sk, scope };
      this.skillMobileDetailOpen = true;
      this.skillContent = '';
      this.skillFiles = [];
      this.selectedSkillFile = 'SKILL.md';
      this.skillFilePath = '';
      this.skillError = '';
      this.skillSaved = false;
      try {
        const r = await fetch(`api/skills/${encodeURIComponent(scope)}/${encodeURIComponent(sk.name)}`);
        const data = await r.json();
        this.skillContent = data.content || '';
        this.skillFiles = data.files || [{ path: 'SKILL.md', isPrimary: true }];
        this.skillFilePath = data.path || '';
      } catch (err) { this.skillError = err.message; this.notify('Skill load failed', 'error'); }
    },

    async saveSkill() {
      this.skillSaving = true; this.skillError = ''; this.skillSaved = false;
      try {
        const filePath = this.selectedSkillFile || 'SKILL.md';
        const url = filePath === 'SKILL.md'
          ? `api/skills/${encodeURIComponent(this.selectedSkill.scope)}/${encodeURIComponent(this.selectedSkill.name)}`
          : `api/skills/${encodeURIComponent(this.selectedSkill.scope)}/${encodeURIComponent(this.selectedSkill.name)}/files/${filePath.split('/').map(encodeURIComponent).join('/')}`;
        const r = await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: this.skillContent }),
        });
        if (!r.ok) { this.skillError = (await r.json()).error; return; }
        this.skillSaved = true;
        this.notify('Skill saved');
        setTimeout(() => { this.skillSaved = false; }, 3000);
      } catch (err) { this.skillError = err.message; this.notify('Skill save failed', 'error'); }
      finally { this.skillSaving = false; }
    },

    async selectSkillFile(file) {
      if (!this.selectedSkill || !file?.path || file.path === this.selectedSkillFile) return;
      this.skillError = '';
      this.skillSaved = false;
      try {
        const relPath = file.path.split('/').map(encodeURIComponent).join('/');
        const r = await fetch(`api/skills/${encodeURIComponent(this.selectedSkill.scope)}/${encodeURIComponent(this.selectedSkill.name)}/files/${relPath}`);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Skill file load failed');
        this.selectedSkillFile = file.path;
        this.skillContent = data.content || '';
        this.skillFilePath = data.path || '';
      } catch (err) {
        this.skillError = err.message;
        this.notify('Skill file load failed', 'error');
      }
    },

    async submitNewSkill() {
      this.newItemError = '';
      if (!this.newSkillName.trim()) { this.newItemError = 'Name is required.'; return; }
      try {
        const r = await fetch('api/skills', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.newSkillName.trim(), scope: this.newSkillScope }),
        });
        if (!r.ok) { this.newItemError = (await r.json()).error; return; }
        this.showNewSkill = false;
        await this.loadSkills();
        const group = this.skillGroups.find(g => g.scope === this.newSkillScope);
        const sk = group && group.skills.find(s => s.name === this.newSkillName.trim());
        if (sk) this.selectSkill(sk, this.newSkillScope);
        this.notify('Skill created');
      } catch (err) { this.newItemError = err.message; this.notify('Skill creation failed', 'error'); }
    },

    async deleteSkill(scope, name) {
      await fetch(`api/skills/${encodeURIComponent(scope)}/${encodeURIComponent(name)}`, { method: 'DELETE' });
      this.selectedSkill = null;
      this.skillContent = '';
      await this.loadSkills();
      this.notify('Skill deleted');
    },

    // ==================== PERSONAS ====================

    async loadPersonas() {
      this.loadingPersonas = true;
      try {
        const r = await fetch('api/personas');
        this.personaGroups = await r.json();
        this.markApiOk();
      } catch (err) { console.error('personas load failed', err); this.reportApiError('Personas load failed', err); }
      finally { this.loadingPersonas = false; }
    },

    async selectPersona(p) {
      this.selectedPersona = p;
      this.personaMobileDetailOpen = true;
      this.personaContent = '';
      this.personaError = '';
      this.personaSaved = false;
      const sp = this.scopeParam(p.scope);
      try {
        const r = await fetch(`api/personas/${encodeURIComponent(p.name)}${sp}`);
        const data = await r.json();
        this.personaContent = data.content || '';
      } catch (err) { this.personaError = err.message; this.notify('Persona load failed', 'error'); }
    },

    async savePersona() {
      this.personaSaving = true; this.personaError = ''; this.personaSaved = false;
      const sp = this.scopeParam(this.selectedPersona.scope);
      try {
        const r = await fetch(`api/personas/${encodeURIComponent(this.selectedPersona.name)}${sp}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: this.personaContent }),
        });
        if (!r.ok) { this.personaError = (await r.json()).error; return; }
        this.personaSaved = true;
        this.notify('Persona saved');
        setTimeout(() => { this.personaSaved = false; }, 3000);
      } catch (err) { this.personaError = err.message; this.notify('Persona save failed', 'error'); }
      finally { this.personaSaving = false; }
    },

    async submitNewPersona() {
      this.newItemError = '';
      if (!this.newPersonaName.trim()) { this.newItemError = 'Name is required.'; return; }
      try {
        const r = await fetch('api/personas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.newPersonaName.trim(), scope: this.newPersonaScope || null }),
        });
        if (!r.ok) { this.newItemError = (await r.json()).error; return; }
        this.showNewPersona = false;
        await this.loadPersonas();
        const group = this.personaGroups.find(g => g.scope === (this.newPersonaScope || null));
        const p = group && group.personas.find(x => x.name === this.newPersonaName.trim());
        if (p) this.selectPersona(p);
        this.notify('Persona created');
      } catch (err) { this.newItemError = err.message; this.notify('Persona creation failed', 'error'); }
    },

    async deletePersona(name, scope) {
      const sp = this.scopeParam(scope);
      await fetch(`api/personas/${encodeURIComponent(name)}${sp}`, { method: 'DELETE' });
      this.selectedPersona = null;
      this.personaContent = '';
      await this.loadPersonas();
      this.notify('Persona deleted');
    },

    // ==================== ACTIONS ====================

    async loadActions() {
      this.loadingActions = true;
      try {
        const r = await fetch('api/actions');
        const data = await r.json();
        this.actionGroups = data;
        this.markApiOk();
      } catch (err) { console.error('actions load failed', err); this.reportApiError('Actions load failed', err); }
      finally { this.loadingActions = false; }
    },

    async selectAction(agent, action, scope) {
      this.selectedAction = { agent, name: action, scope };
      this.actionMobileDetailOpen = true;
      this.actionContent = '';
      this.actionAssignedAgents = [];
      this.actionError = '';
      this.actionSaved = false;
      const sp = this.scopeParam(scope);
      try {
        const r = await fetch(`api/actions/${encodeURIComponent(agent)}/${encodeURIComponent(action)}${sp}`);
        const data = await r.json();
        this.actionContent = data.content || '';
        this.actionAssignedAgents = (data.agents && data.agents.length ? data.agents : [agent]).slice();
      } catch (err) { this.actionError = err.message; this.notify('Action load failed', 'error'); }
    },

    actionAgentOptions(scope = this.selectedAction?.scope) {
      const wantedScope = this.normalizeWorkflowScope(scope);
      const scopes = wantedScope ? [wantedScope, null] : [null];
      const seen = new Set();
      const options = [];
      for (const agent of this.agents || []) {
        const agentScope = this.normalizeWorkflowScope(agent.scope);
        if (!scopes.includes(agentScope)) continue;
        const key = agent.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        options.push({
          name: agent.name,
          scope: agentScope,
          label: this.workflowOptionLabel(agent.name, agentScope),
        });
      }
      return options.sort((a, b) => a.label.localeCompare(b.label));
    },

    onNewActionScopeChange() {
      const valid = new Set(this.actionAgentOptions(this.newActionScope).map(agent => agent.name));
      this.newActionAgents = this.newActionAgents.filter(agent => valid.has(agent));
      if (!valid.has(this.newActionAgent)) this.newActionAgent = '';
    },

    onNewActionPrimaryChange() {
      if (this.newActionAgent && !this.newActionAgents.includes(this.newActionAgent)) {
        this.newActionAgents = [this.newActionAgent, ...this.newActionAgents];
      }
    },

    normalizeActionAgents(agents) {
      const seen = new Set();
      return (agents || [])
        .map(agent => String(agent || '').trim())
        .filter(Boolean)
        .filter(agent => {
          const key = agent.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    },

    setActionAgentsInContent(content, agents) {
      const cleanAgents = this.normalizeActionAgents(agents);
      const agentBlock = ['agents:', ...cleanAgents.map(agent => `  - ${agent}`)].join('\n');
      const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n?/);
      if (!frontmatter) return `---\n${agentBlock}\n---\n\n${content}`;

      const lines = frontmatter[1].split('\n');
      const kept = [];
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (/^\s*(agents|agent|appliesTo|applies-to):/.test(line)) {
          while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) i += 1;
          continue;
        }
        kept.push(line);
      }
      const nextFrontmatter = [agentBlock, ...kept.filter(line => line.trim())].join('\n');
      return `---\n${nextFrontmatter}\n---\n\n${content.slice(frontmatter[0].length)}`;
    },

    parseActionAgentsFromContent(content) {
      const frontmatter = String(content || '').match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatter) return [];
      const lines = frontmatter[1].split('\n');
      const agents = [];
      for (let i = 0; i < lines.length; i += 1) {
        const inline = lines[i].match(/^\s*(agents|agent|appliesTo|applies-to):\s*(.+?)\s*$/);
        if (inline) {
          const value = inline[2].trim();
          if (value.startsWith('[') && value.endsWith(']')) {
            return this.normalizeActionAgents(value.slice(1, -1).split(',').map(item => item.replace(/^["']|["']$/g, '').trim()));
          }
          return this.normalizeActionAgents(value.split(','));
        }
        if (/^\s*(agents|appliesTo|applies-to):\s*$/.test(lines[i])) {
          for (let j = i + 1; j < lines.length; j += 1) {
            const item = lines[j].match(/^\s*-\s+(.+?)\s*$/);
            if (!item) break;
            agents.push(item[1].replace(/^["']|["']$/g, ''));
          }
          return this.normalizeActionAgents(agents);
        }
      }
      return [];
    },

    syncActionAgentsFromContent() {
      const parsed = this.parseActionAgentsFromContent(this.actionContent);
      if (parsed.length > 0) this.actionAssignedAgents = parsed;
    },

    updateActionAssignments() {
      this.actionAssignedAgents = this.normalizeActionAgents(this.actionAssignedAgents);
      if (this.actionAssignedAgents.length === 0 && this.selectedAction?.agent) {
        this.actionAssignedAgents = [this.selectedAction.agent];
      }
      this.actionContent = this.setActionAgentsInContent(this.actionContent, this.actionAssignedAgents);
    },

    async saveAction() {
      this.actionSaving = true; this.actionError = ''; this.actionSaved = false;
      const sp = this.scopeParam(this.selectedAction.scope);
      try {
        const r = await fetch(`api/actions/${encodeURIComponent(this.selectedAction.agent)}/${encodeURIComponent(this.selectedAction.name)}${sp}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: this.actionContent }),
        });
        if (!r.ok) { this.actionError = (await r.json()).error; return; }
        this.actionSaved = true;
        this.notify('Action saved');
        setTimeout(() => this.actionSaved = false, 2000);
      } catch (err) { this.actionError = err.message; this.notify('Action save failed', 'error'); }
      finally { this.actionSaving = false; }
    },

    async submitNewAction() {
      this.newItemError = '';
      const agents = this.normalizeActionAgents(this.newActionAgents.length ? this.newActionAgents : [this.newActionAgent]);
      if (agents.length === 0 || !this.newActionName.trim()) {
        this.newItemError = 'At least one agent and an action name are required';
        return;
      }
      try {
        const primaryAgent = this.newActionAgent || agents[0];
        const sp = this.newActionScope ? `?scope=${encodeURIComponent(this.newActionScope)}` : '';
        const r = await fetch(`api/actions/${encodeURIComponent(primaryAgent)}${sp}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.newActionName.trim(), agents }),
        });
        if (!r.ok) { this.newItemError = (await r.json()).error; return; }
        this.showNewAction = false;
        await this.loadActions();
        // Find and select the newly created action
        for (const group of this.actionGroups) {
          for (const agent of group.agents) {
            if (agent.name === primaryAgent) {
              const action = agent.actions.find(a => a.name === this.newActionName.trim());
              if (action) this.selectAction(agent.name, action.name, group.scope);
            }
          }
        }
        this.notify('Action created');
      } catch (err) { this.newItemError = err.message; this.notify('Action creation failed', 'error'); }
    },

    async deleteSelectedAction(agent, name, scope) {
      const sp = this.scopeParam(scope);
      const r = await fetch(`api/actions/${encodeURIComponent(agent)}/${encodeURIComponent(name)}${sp}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error || 'Failed to delete action');
      this.selectedAction = null;
      this.actionContent = '';
      await this.loadActions();
      this.notify('Action deleted');
    },

    // ==================== PROJECTS ====================

    async loadProjects() {
      this.loadingProjects = true;
      try {
        const r = await fetch('api/projects');
        this.projects = await r.json();
        this.loadChannelDirectory();
        this.markApiOk();
      } catch (err) { console.error('projects load failed', err); this.reportApiError('Projects load failed', err); }
      finally { this.loadingProjects = false; }
    },

    async loadChannelDirectory() {
      try {
        const r = await fetch('api/projects/channel-directory');
        const data = await r.json();
        this.channelDir = data.channels || [];
        this.channelDirError = data.ok === false ? (data.error || '') : '';
        const names = {};
        for (const c of this.channelDir) names[c.id] = c.name;
        this.channelNames = names;
      } catch (err) { this.channelDir = []; this.channelDirError = String(err); }
    },

    channelLabel(id) {
      return this.channelNames && this.channelNames[id] ? '#' + this.channelNames[id] : id;
    },

    async addProjectChannelById(project, channelId) {
      if (!channelId) return;
      project._newChannel = channelId;
      await this.addProjectChannel(project);
    },

    // ---- Onboarding ----
    async loadOnboarding(fresh) {
      this.loadingOnboarding = true;
      try {
        const reqs = [fetch('api/onboarding/status' + (fresh ? '?fresh=1' : ''))];
        if (!this.guide.length) reqs.push(fetch('api/onboarding/guide'));
        const [statusR, guideR] = await Promise.all(reqs);
        this.onboarding = await statusR.json();
        if (guideR) this.guide = (await guideR.json()).guide || [];
        if (!this.activeGuideId && this.guide.length) {
          // open the first integration that isn't ready yet (else the first one)
          const firstNotOk = this.guide.find((g) => g.check && this.guideStatus(g) !== 'ok');
          this.activeGuideId = (firstNotOk || this.guide[0]).id;
        }
        this.markApiOk();
      } catch (err) { console.error('onboarding load failed', err); this.reportApiError('Onboarding status failed', err); }
      finally { this.loadingOnboarding = false; }
    },

    // live status for a guide item ('ok' | 'warn' | 'missing' | '' for manual/no-check)
    guideStatus(g) {
      if (!g || !g.check) return '';
      const it = (this.onboarding.items || []).find((i) => i.id === g.check);
      return it ? it.status : '';
    },
    guideDetail(g) {
      if (!g || !g.check) return '';
      const it = (this.onboarding.items || []).find((i) => i.id === g.check);
      return it ? it.detail : '';
    },
    statusIcon(s) { return s === 'ok' ? '✓' : (s === 'warn' ? '⚠' : (s === 'missing' || s === 'error' ? '✗' : '○')); },
    statusColor(s) { return s === 'ok' ? 'text-green-400' : (s === 'warn' ? 'text-amber-400' : (s === 'missing' || s === 'error' ? 'text-red-400' : 'text-gray-600')); },
    get activeGuide() { return this.guide.find((g) => g.id === this.activeGuideId) || null; },

    // re-run a single integration's check after the user follows the steps
    async verifyGuide(g) {
      if (!g || !g.check) return;
      this.verifyingId = g.id;
      try {
        const r = await fetch('api/onboarding/status/' + g.check);
        const item = await r.json();
        const items = (this.onboarding.items || []).slice();
        const idx = items.findIndex((i) => i.id === g.check);
        if (idx >= 0) items[idx] = item; else items.push(item);
        this.onboarding = { ...this.onboarding, items, summary: {
          ok: items.filter((i) => i.status === 'ok').length,
          warn: items.filter((i) => i.status === 'warn').length,
          missing: items.filter((i) => i.status === 'missing' || i.status === 'error').length,
          total: items.length,
        } };
        this.notify(item.status === 'ok' ? (g.label + ' is ready ✓') : (g.label + ': ' + (item.detail || item.status)));
      } catch (err) { this.reportApiError('Verify failed', err); }
      finally { this.verifyingId = ''; }
    },

    async copyCode(text, key) {
      try {
        await navigator.clipboard.writeText(text);
        this.copiedKey = key;
        setTimeout(() => { if (this.copiedKey === key) this.copiedKey = ''; }, 1500);
      } catch (e) { /* clipboard blocked — no-op */ }
    },

    async savePreference() {
      this.prefMsg = ''; this.prefErr = false;
      if (!this.prefText.trim()) { this.prefErr = true; this.prefMsg = 'Enter a preference first.'; return; }
      try {
        const r = await fetch('api/onboarding/preferences', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: this.prefScope, text: this.prefText }),
        });
        const data = await r.json();
        if (!r.ok) { this.prefErr = true; this.prefMsg = data.error || 'Save failed'; return; }
        this.prefMsg = 'Saved → ' + data.file;
        this.prefText = '';
        this.notify('Preference saved to CLAUDE.md');
        setTimeout(() => { this.prefMsg = ''; }, 6000);
      } catch (err) { this.prefErr = true; this.prefMsg = err.message; }
    },

    async submitNewProject() {
      this.newProjectError = '';
      if (!this.newProjectName.trim()) { this.newProjectError = 'Name is required.'; return; }
      try {
        const r = await fetch('api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.newProjectName.trim() }),
        });
        if (!r.ok) { this.newProjectError = (await r.json()).error; return; }
        this.showNewProject = false;
        await this.loadProjects();
        this.notify('Project created');
      } catch (err) { this.newProjectError = err.message; this.notify('Project creation failed', 'error'); }
    },

    async saveProjectBinding(project) {
      project._savedMsg = ''; project._savedErr = false;
      try {
        const r = await fetch(`api/projects/${encodeURIComponent(project.name)}/bindings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ salesforce: project.salesforce, drivePath: project.drivePath }),
        });
        const data = await r.json();
        if (!r.ok) { project._savedErr = true; project._savedMsg = data.error || 'Save failed'; return; }
        project._savedMsg = 'Saved ✓';
        this.notify(`Bindings saved for ${project.name}`);
        setTimeout(() => { project._savedMsg = ''; }, 3000);
      } catch (err) { project._savedErr = true; project._savedMsg = err.message; this.notify('Bindings save failed', 'error'); }
    },

    async addProjectChannel(project) {
      const channelId = (project._newChannel || '').trim();
      project._chanMsg = ''; project._chanErr = false;
      if (!channelId) return;
      try {
        const r = await fetch(`api/projects/${encodeURIComponent(project.name)}/channels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelId }),
        });
        const data = await r.json();
        if (!r.ok) { project._chanErr = true; project._chanMsg = data.error || 'Failed to map channel'; return; }
        project.channels = data.channels || [...(project.channels || []), channelId];
        project._newChannel = '';
        this.notify(`Channel mapped to ${project.name}`);
        // a channel maps to one project — reload so any reassigned project's card updates too
        await this.loadProjects();
      } catch (err) { project._chanErr = true; project._chanMsg = err.message; }
    },

    async removeProjectChannel(project, channelId) {
      project._chanMsg = ''; project._chanErr = false;
      try {
        const r = await fetch(`api/projects/${encodeURIComponent(project.name)}/channels/${encodeURIComponent(channelId)}`, { method: 'DELETE' });
        const data = await r.json();
        if (!r.ok) { project._chanErr = true; project._chanMsg = data.error || 'Failed to unmap'; return; }
        project.channels = data.channels || (project.channels || []).filter(c => c !== channelId);
        this.notify('Channel unmapped');
      } catch (err) { project._chanErr = true; project._chanMsg = err.message; }
    },

    // ==================== AVAILABLE TOOLS ====================

    async loadTools() {
      if (this.availableTools && this._loadedToolsScope === this.toolsScope) return;
      this.loadingTools = true;
      try {
        const url = this.toolsScope ? `api/available-tools?scope=${encodeURIComponent(this.toolsScope)}` : 'api/available-tools';
        const r = await fetch(url);
        this.availableTools = await r.json();
        this._loadedToolsScope = this.toolsScope;
        this.markApiOk();
      } catch (err) { console.error('tools load failed', err); this.reportApiError('Tools load failed', err); }
      finally { this.loadingTools = false; }
    },

    toolsByCategory(tools) {
      const groups = {};
      for (const t of tools) {
        if (!groups[t.category]) groups[t.category] = [];
        groups[t.category].push(t);
      }
      return Object.entries(groups).map(([category, items]) => ({ category, items }));
    },

    // ==================== TOOLSETS ====================

    async loadToolsets() {
      this.loadingToolsets = true;
      try {
        const [r] = await Promise.all([fetch('api/toolsets'), this.loadTools()]);
        this.toolsets = await r.json();
        this.markApiOk();
      } catch (err) { console.error('toolsets load failed', err); this.reportApiError('Toolsets load failed', err); }
      finally { this.loadingToolsets = false; }
    },

    async saveToolsets() {
      this.toolsetsSaving = true; this.toolsetsError = ''; this.toolsetsSaved = false;
      try {
        const r = await fetch('api/toolsets', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolsets: this.toolsets }),
        });
        if (!r.ok) { this.toolsetsError = (await r.json()).error; return; }
        this.toolsetsSaved = true;
        this.notify('Toolsets saved');
        setTimeout(() => { this.toolsetsSaved = false; }, 3000);
      } catch (err) { this.toolsetsError = err.message; this.notify('Toolsets save failed', 'error'); }
      finally { this.toolsetsSaving = false; }
    },

    addToolset() {
      this.toolsets.push({ name: '', tools: '' });
    },

    toolsetToolsList(ts) {
      return (ts.tools || '').split(',').map(t => t.trim()).filter(Boolean);
    },

    toolsetHasTool(ts, name) {
      return this.toolsetToolsList(ts).includes(name);
    },

    toolsetToggleTool(ts, name) {
      const list = this.toolsetToolsList(ts);
      const i = list.indexOf(name);
      if (i === -1) list.push(name);
      else list.splice(i, 1);
      ts.tools = list.join(',');
    },

    toolsetRemoveTool(ts, name) {
      ts.tools = this.toolsetToolsList(ts).filter(t => t !== name).join(',');
    },

    toolsetAllTools() {
      if (!this.availableTools) return [];
      const sdk = (this.availableTools.sdkTools || []).map(t => ({ ...t, source: 'sdk' }));
      const rt = (this.availableTools.agentRuntimeTools || []).map(t => ({ ...t, category: 'Agent Runtime', source: 'runtime' }));
      return [...sdk, ...rt];
    },

    toolsetFilteredCategories() {
      const q = (this.toolsetPickerQuery || '').toLowerCase();
      const tools = this.toolsetAllTools().filter(t =>
        !q || t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q)
      );
      const groups = {};
      for (const t of tools) {
        if (!groups[t.category]) groups[t.category] = [];
        groups[t.category].push(t);
      }
      return Object.entries(groups).map(([category, items]) => ({ category, items }));
    },

    // ==================== ACTION EDITING ====================

    async openEditAction(agentName, actionName) {
      const scope = this.selectedAgent ? this.selectedAgent.scope : null;
      this.editAction = { agentName, name: actionName, content: '', isNew: false, scope };
      this.editActionError = ''; this.editActionSaved = false;
      const sp = this.scopeParam(scope);
      try {
        const r = await fetch(`api/actions/${encodeURIComponent(agentName)}/${encodeURIComponent(actionName)}${sp}`);
        const data = await r.json();
        this.editAction.content = data.content || '';
      } catch (err) { this.editAction.content = ''; }
      this.showEditAction = true;
    },

    openNewAction(agentName) {
      const scope = this.selectedAgent ? this.selectedAgent.scope : null;
      this.editAction = { agentName, name: '', content: '', isNew: true, scope };
      this.editActionError = ''; this.editActionSaved = false;
      this.showEditAction = true;
    },

    async saveEditAction() {
      this.editActionSaving = true; this.editActionError = ''; this.editActionSaved = false;
      const sp = this.scopeParam(this.editAction.scope);
      try {
        if (this.editAction.isNew) {
          if (!this.editAction.name.trim()) { this.editActionError = 'Name is required.'; return; }
          this.editAction.name = this.editAction.name.trim();
          const createR = await fetch(`api/actions/${encodeURIComponent(this.editAction.agentName)}${sp}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: this.editAction.name }),
          });
          if (!createR.ok) { this.editActionError = (await createR.json()).error; return; }
          this.editAction.isNew = false;
        }
        const r = await fetch(`api/actions/${encodeURIComponent(this.editAction.agentName)}/${encodeURIComponent(this.editAction.name)}${sp}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: this.editAction.content }),
        });
        if (!r.ok) { this.editActionError = (await r.json()).error; return; }
        this.editActionSaved = true;
        setTimeout(() => { this.editActionSaved = false; }, 3000);
        if (this.selectedAgent && this.selectedAgent.name === this.editAction.agentName) {
          const ar = await fetch(`api/agents/${this.editAction.agentName}/actions${sp}`);
          this.detailActions = await ar.json();
        }
        await this.loadActions();
        if (this.selectedAction && this.selectedAction.agent === this.editAction.agentName && this.selectedAction.name === this.editAction.name && this.selectedAction.scope === this.editAction.scope) {
          this.actionContent = this.editAction.content;
        }
        this.showEditAction = false;
        this.notify('Action saved');
      } catch (err) { this.editActionError = err.message; this.notify('Action save failed', 'error'); }
      finally { this.editActionSaving = false; }
    },

    async deleteEditAction(agentName, actionName) {
      this.editActionError = '';
      const sp = this.scopeParam(this.editAction.scope);
      const r = await fetch(`api/actions/${encodeURIComponent(agentName)}/${encodeURIComponent(actionName)}${sp}`, { method: 'DELETE' });
      if (!r.ok) { this.editActionError = (await r.json()).error; return; }
      this.showEditAction = false;
      if (this.selectedAgent && this.selectedAgent.name === agentName) {
        const ar = await fetch(`api/agents/${agentName}/actions${sp}`);
        this.detailActions = await ar.json();
      }
      if (this.selectedAction && this.selectedAction.agent === agentName && this.selectedAction.name === actionName && this.selectedAction.scope === this.editAction.scope) {
        this.selectedAction = null;
        this.actionContent = '';
      }
      await this.loadActions();
      this.notify('Action deleted');
    },

    // ==================== SHARED DELETE CONFIRM ====================

    confirmDeleteItem(type, name, action) {
      this.confirmDelete = { show: true, name: `${type}: ${name}`, action: async () => {
        await action();
        this.confirmDelete.show = false;
      }};
    },

    // ==================== HELPERS ====================

    formatDate(iso) {
      return new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' });
    },

    formatAge(ms) {
      if (ms < 60000) return Math.floor(ms / 1000) + 's ago';
      if (ms < 3600000) return Math.floor(ms / 60000) + 'm ago';
      if (ms < 86400000) return Math.floor(ms / 3600000) + 'h ago';
      return Math.floor(ms / 86400000) + 'd ago';
    },

    formatDuration(ms) {
      if (!ms && ms !== 0) return '-';
      if (ms < 1000) return ms + 'ms';
      if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
      if (ms < 3600000) return Math.round(ms / 60000) + 'm';
      return (ms / 3600000).toFixed(1) + 'h';
    },

    formatUsd(value) {
      if (!value && value !== 0) return '-';
      if (value < 0.01) return '$' + value.toFixed(4);
      return '$' + value.toFixed(2);
    },

    formatNumber(value) {
      if (!value && value !== 0) return '-';
      return Number(value).toLocaleString('en-US');
    },

    formatBytes(bytes) {
      if (!bytes) return '0 B';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    },
  };
}

window.app = app;
